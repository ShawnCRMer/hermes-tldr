import contextvars
import hashlib
import json
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

MAX_BODY = 256 * 1024
RECEIPT_TTL = 600
MAX_ROUTE_PART = 256
MAX_SOURCE_TEXT = 32_000
MAX_CONTEXT_ITEMS = 12
MAX_CONTEXT_TEXT = 24_000
LLM_WAIT_SECONDS = 60.0
_PROMPT = json.loads((Path(__file__).with_name('prompt.json')).read_text())
FIXED_INSTRUCTIONS = _PROMPT['instructions']
_V2 = _PROMPT.get('v2') or {}
V2_SECTIONS = _V2.get('sections') or {}
V2_MAX_TOKENS = _V2.get('maxTokens') or {'S': 900, 'M': 2500, 'L': 4096}
INPUT_VERSIONS = [1, 2] if V2_SECTIONS else [1]
MAX_TOOLS = 40
MAX_TOOL_NAME = 64
MAX_TOOL_CONTEXT = 160
MAX_PREFERENCES = 500
MAX_HISTORY_MESSAGES = 600
import re as _re
_SESSION_ID = _re.compile(r'^[A-Za-z0-9_.:-]{1,128}$')
V2_OPTION_KEYS = {'length', 'statusFirst', 'evidence', 'conflicts', 'decisionScope', 'recommend', 'preferences'}
V2_ENUMS = {'length': {'S', 'M', 'L'}, 'decisionScope': {'design', 'all'}, 'recommend': {'permanent', 'balanced', 'quick'}}
_AUTO_SENTINELS = {'', 'auto', 'automatic', 'default', '__auto__', 'none', 'null'}


def _value(value, key, default=None):
    if isinstance(value, dict):
        return value.get(key, default)
    return getattr(value, key, default)


def _safe_component(value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > MAX_ROUTE_PART:
        raise ValueError('invalid_assignment')
    value = value.strip()
    return None if value.lower() in _AUTO_SENTINELS else value


def _read_assignment(raw):
    """Reduce the host config to the named auxiliary task, without exposing secrets."""
    if not isinstance(raw, dict):
        raise ValueError('invalid_assignment')
    auxiliary = raw.get('auxiliary', {})
    if auxiliary is None:
        auxiliary = {}
    if not isinstance(auxiliary, dict):
        raise ValueError('invalid_assignment')
    node = auxiliary.get('tldr_summary')
    if node is None:
        return {'state': 'auto', 'provider': None, 'model': None, 'hasCustomEndpoint': False,
                'observedAt': _timestamp(), 'reason': None}
    if not isinstance(node, dict):
        raise ValueError('invalid_assignment')
    provider = _safe_component(node.get('provider'))
    model = _safe_component(node.get('model'))
    endpoint = node.get('base_url', node.get('baseUrl'))
    if endpoint is not None and not isinstance(endpoint, str):
        raise ValueError('invalid_assignment')
    has_endpoint = isinstance(endpoint, str) and bool(endpoint.strip())
    pinned = bool(provider or model or has_endpoint)
    return {'state': 'pinned' if pinned else 'auto', 'provider': provider, 'model': model,
            'hasCustomEndpoint': has_endpoint, 'observedAt': _timestamp(), 'reason': None}


def _timestamp():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def _unknown_assignment(reason):
    return {'state': 'unknown', 'provider': None, 'model': None, 'hasCustomEndpoint': False,
            'observedAt': None, 'reason': reason}


def _sanitize_assignment(raw):
    try:
        return _read_assignment(raw)
    except ValueError:
        return _unknown_assignment('invalid_assignment')


def _actual_route(result):
    provider = _safe_actual(_value(result, 'provider'))
    model = _safe_actual(_value(result, 'model'))
    return {'provider': provider, 'model': model}


def _safe_actual(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return None if not value or value.lower() in _AUTO_SENTINELS else value[:MAX_ROUTE_PART]


def _sanitize_usage(value):
    if value is None:
        return None
    result = {}
    for key in ('input_tokens', 'output_tokens', 'total_tokens'):
        candidate = _value(value, key)
        if isinstance(candidate, int) and not isinstance(candidate, bool) and candidate >= 0:
            result[key] = candidate
    cost = _value(value, 'cost', _value(value, 'cost_usd'))
    result['cost'] = cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0 else None
    return result


def _load_host_config():
    """Read the active profile's config through Hermes' supported config API."""
    from hermes_cli.config import load_config_readonly
    return load_config_readonly() or {}


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(part.get('text', '') for part in content if isinstance(part, dict) and part.get('type') in ('text', 'input_text', 'output_text') and isinstance(part.get('text'), str))
    return ''


def _tool_preview(args):
    if not isinstance(args, dict):
        return ''
    for key in ('command', 'path', 'url', 'urls', 'query', 'code', 'goal', 'name'):
        if key in args:
            return ' '.join(str(args[key]).split())[:80]
    return ''


def _project_history(history):
    """Minimal, read-only projection of stored rows into the fields TL;DR reads
    (role, text, row_id, display_kind; tool name + short argument preview)."""
    try:
        from agent.compaction_display import project_compaction_message_for_display as compaction
    except Exception:
        compaction = None
    calls = {}
    out = []
    for message in history:
        if not isinstance(message, dict):
            continue
        if compaction is not None:
            try:
                message = compaction(message)
            except Exception:
                pass
            if message is None:
                continue
        role = message.get('role')
        kind = message.get('display_kind')
        if role == 'assistant' and isinstance(message.get('tool_calls'), list):
            for call in message['tool_calls']:
                function = (call or {}).get('function') or {}
                try:
                    args = json.loads(function.get('arguments') or '{}')
                except (TypeError, ValueError):
                    args = {}
                calls[(call or {}).get('id')] = (function.get('name'), _tool_preview(args))
        if kind == 'hidden' or role not in ('user', 'assistant', 'tool'):
            continue
        if role == 'tool':
            name, preview = calls.get(message.get('tool_call_id'), (None, ''))
            out.append({'role': 'tool', 'name': name or message.get('tool_name') or 'tool', 'context': preview})
            continue
        text = _text_of(message.get('content'))
        if not text.strip() or (role == 'user' and text.lstrip().startswith('[System:')):
            continue
        row = {'role': role, 'text': text}
        if message.get('_row_id') is not None:
            row['row_id'] = message['_row_id']
        if kind:
            row['display_kind'] = kind
        out.append(row)
    return out


def compose_v2_instructions(mode, options):
    """Build the fixed v2 system prompt. Only the user's short preferences note is free text."""
    s = V2_SECTIONS
    length = s['length'][options['length']]
    preferences = ' '.join(options['preferences'].replace(chr(34) * 3, chr(34)).split())
    text = s['base']
    replacements = {
        '{MODE}': s['mode'][mode],
        '{BOTTOM}': length['bottom'], '{CHANGES}': length['changes'], '{RISKS}': length['risks'],
        '{DETAIL_CONTEXT}': length['context'], '{LOCKED}': length['locked'],
        '{SCOPE}': s['scope'][options['decisionScope']],
        '{RECOMMEND}': s['recommend'][options['recommend']],
        '{STATUS}': s['status'] if options['statusFirst'] else s['noStatus'],
        '{EVIDENCE}': s['evidence'] if options['evidence'] else s['noEvidence'],
        '{CONFLICTS}': s['conflicts'] if options['conflicts'] and mode == 'session' else s['noConflicts'],
        '{PREFERENCES}': s['preferences'].replace('{TEXT}', preferences) if preferences else '',
    }
    for key, value in replacements.items():
        text = text.replace(key, value)
    return text


class TldrService:
    def __init__(self, ctx, profile, instance, registration_ready=True):
        self.ctx = ctx
        self.profile = profile
        self.instance = instance
        self.registration_ready = registration_ready
        self._lock = threading.RLock()
        self._active = False
        self._active_request = None
        self._inflight = {}
        self._receipts = OrderedDict()

    def mark_registration(self, ready):
        self.registration_ready = ready is True

    def assignment(self):
        try:
            raw = _load_host_config()
        except Exception:
            return _unknown_assignment('read_failed')
        return _sanitize_assignment(raw)

    def capabilities(self):
        assignment = self.assignment()
        llm_ready = callable(getattr(getattr(self.ctx, 'llm', None), 'complete', None))
        ready = self.registration_ready and llm_ready and assignment['reason'] is None
        reason = None
        if not self.registration_ready:
            reason = 'task_unavailable'
        elif not llm_ready:
            reason = 'llm_unavailable'
        elif assignment['reason'] == 'read_failed':
            reason = 'assignment_unreadable'
        elif assignment['reason'] == 'invalid_assignment':
            reason = 'assignment_unreadable'
        return {
            'apiVersion': 3, 'pluginId': 'tldr', 'task': 'tldr_summary',
            'backendInstanceId': self.instance if ready or self.registration_ready else None,
            'profile': self.profile if ready or self.registration_ready else None,
            'ready': bool(ready), 'reason': reason, 'assignment': assignment,
            'inputVersions': list(INPUT_VERSIONS),
            'storedHistory': True,
        }

    def _validate(self, payload):
        if not isinstance(payload, dict) or payload.get('apiVersion') != 3:
            raise ValueError('invalid_input')
        if set(payload) != {'apiVersion', 'requestId', 'expectedBackendInstanceId', 'expectedProfile', 'input'}:
            raise ValueError('invalid_input')
        request_id = payload['requestId']
        if not isinstance(request_id, str) or not request_id or len(request_id) > 128:
            raise ValueError('invalid_input')
        if (not isinstance(payload['expectedBackendInstanceId'], str) or
                not isinstance(payload['expectedProfile'], str) or
                not payload['expectedBackendInstanceId'] or not payload['expectedProfile'] or
                len(payload['expectedBackendInstanceId']) > MAX_ROUTE_PART or
                len(payload['expectedProfile']) > MAX_ROUTE_PART):
            raise ValueError('invalid_input')
        if payload['expectedBackendInstanceId'] != self.instance or payload['expectedProfile'] != self.profile:
            raise PermissionError('scope_mismatch')
        inp = payload['input']
        if not isinstance(inp, dict):
            raise ValueError('invalid_input')
        if inp.get('schemaVersion') == 2 and 2 in INPUT_VERSIONS:
            self._validate_v2_extras(inp)
        elif set(inp) != {'schemaVersion', 'source', 'context', 'contextTruncated'} or inp.get('schemaVersion') != 1:
            raise ValueError('invalid_input')
        source = inp['source']; context = inp['context']
        if (not isinstance(source, dict) or set(source) != {'rowId', 'text'} or
                isinstance(source['rowId'], bool) or not isinstance(source['rowId'], int) or
                source['rowId'] <= 0 or source['rowId'] > 2**53 - 1 or
                not isinstance(source['text'], str) or not source['text'].strip() or
                len(source['text']) > MAX_SOURCE_TEXT or not isinstance(context, list) or
                len(context) > MAX_CONTEXT_ITEMS or not isinstance(inp['contextTruncated'], bool)):
            raise ValueError('invalid_input')
        context_size = 0
        for item in context:
            if (not isinstance(item, dict) or set(item) != {'role', 'text'} or
                    item['role'] not in {'user', 'assistant'} or not isinstance(item['text'], str) or
                    not item['text'].strip() or len(item['text']) > MAX_SOURCE_TEXT):
                raise ValueError('invalid_input')
            context_size += len(item['text'])
        if context_size > MAX_CONTEXT_TEXT:
            raise ValueError('invalid_input')
        try:
            encoded = json.dumps(payload, separators=(',', ':'), allow_nan=False)
        except (TypeError, ValueError):
            raise ValueError('invalid_input')
        if len(encoded.encode()) > MAX_BODY:
            raise ValueError('invalid_input')
        if not self.registration_ready:
            raise RuntimeError('task_unavailable')
        if not callable(getattr(getattr(self.ctx, 'llm', None), 'complete', None)):
            raise RuntimeError('llm_unavailable')
        assignment = self.assignment()
        if assignment['reason'] is not None:
            raise RuntimeError('assignment_unreadable')
        return inp, request_id, assignment

    def history(self, payload):
        """Read a saved chat by its stored id when Desktop has no live copy of it.
        Read-only, this profile's own state.db, same projection as session.history."""
        if not isinstance(payload, dict) or set(payload) != {'apiVersion', 'expectedBackendInstanceId', 'expectedProfile', 'sessionId'} or payload.get('apiVersion') != 3:
            raise ValueError('invalid_input')
        if payload['expectedBackendInstanceId'] != self.instance or payload['expectedProfile'] != self.profile:
            raise PermissionError('scope_mismatch')
        session_id = payload['sessionId']
        if not isinstance(session_id, str) or not _SESSION_ID.match(session_id):
            raise ValueError('invalid_input')
        from hermes_state import SessionDB
        db = SessionDB(read_only=True)
        try:
            conversation = db.get_messages_as_conversation(session_id, include_ancestors=True, include_row_ids=True)
        finally:
            try:
                db.close()
            except Exception:
                pass
        if not conversation:
            raise LookupError('not_found')
        messages = _project_history(list(conversation))[-MAX_HISTORY_MESSAGES:]
        return {'apiVersion': 3, 'backendInstanceId': self.instance, 'profile': self.profile, 'sessionId': session_id, 'count': len(messages), 'messages': messages}

    @staticmethod
    def _validate_v2_extras(inp):
        if set(inp) != {'schemaVersion', 'mode', 'source', 'context', 'contextTruncated', 'options', 'tools'}:
            raise ValueError('invalid_input')
        if inp['mode'] not in {'last', 'since', 'session'}:
            raise ValueError('invalid_input')
        options = inp['options']
        if not isinstance(options, dict) or set(options) != V2_OPTION_KEYS:
            raise ValueError('invalid_input')
        for key, allowed in V2_ENUMS.items():
            if options[key] not in allowed:
                raise ValueError('invalid_input')
        for key in ('statusFirst', 'evidence', 'conflicts'):
            if not isinstance(options[key], bool):
                raise ValueError('invalid_input')
        if not isinstance(options['preferences'], str) or len(options['preferences']) > MAX_PREFERENCES:
            raise ValueError('invalid_input')
        tools = inp['tools']
        if not isinstance(tools, list) or len(tools) > MAX_TOOLS:
            raise ValueError('invalid_input')
        for index, item in enumerate(tools):
            if (not isinstance(item, dict) or set(item) != {'i', 'name', 'context'} or
                    isinstance(item['i'], bool) or item['i'] != index or not isinstance(item['name'], str) or
                    not item['name'] or len(item['name']) > MAX_TOOL_NAME or
                    not isinstance(item['context'], str) or len(item['context']) > MAX_TOOL_CONTEXT):
                raise ValueError('invalid_input')

    def _prune(self, now):
        while self._receipts:
            key, value = next(iter(self._receipts.items()))
            if now - value['created'] <= RECEIPT_TTL:
                break
            self._receipts.pop(key)

    @staticmethod
    def _digest(payload):
        try:
            encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False)
        except (TypeError, ValueError):
            return None
        return hashlib.sha256(encoded.encode()).hexdigest()

    @staticmethod
    def _request_id(payload):
        return payload.get('requestId') if isinstance(payload, dict) and isinstance(payload.get('requestId'), str) else None

    def _begin(self, request_id, digest):
        with self._lock:
            self._prune(time.monotonic())
            prior = self._receipts.get(request_id)
            if prior is not None:
                if prior['digest'] != digest:
                    raise ValueError('invalid_input')
                if prior.get('error'):
                    if prior['error'] == 'timeout':
                        raise TimeoutError('timeout')
                    raise RuntimeError(prior['error'])
                return prior, False
            pending = self._inflight.get(request_id)
            if pending is not None:
                if pending['digest'] != digest:
                    raise ValueError('invalid_input')
                raise RuntimeError('in_progress')
            if self._active:
                raise RuntimeError('busy')
            entry = {'digest': digest, 'created': time.monotonic(), 'detached': False}
            self._inflight[request_id] = entry
            self._active = True
            self._active_request = request_id
            return entry, True

    def _finish(self, request_id, entry, result=None, digest=None, error=None):
        with self._lock:
            current = self._inflight.get(request_id)
            if current is not entry:
                return
            self._inflight.pop(request_id, None)
            if self._active_request == request_id:
                self._active = False
                self._active_request = None
            if result is not None or error is not None:
                receipt = {'digest': digest or entry['digest'], 'created': time.monotonic()}
                if result is not None:
                    receipt['result'] = result
                if error is not None:
                    receipt['error'] = error
                self._receipts[request_id] = receipt
                while len(self._receipts) > 16:
                    self._receipts.popitem(last=False)

    def _complete(self, llm, messages, request_id, entry, max_tokens=4096):
        outcome = {}
        done = threading.Event()

        def run():
            try:
                # Protocol 3: the owned task is the only routing input. Do not add
                # provider/model/profile/agent_id overrides or a legacy fallback.
                outcome['response'] = llm.complete(
                    messages=messages, task='tldr_summary', temperature=0.2,
                    max_tokens=max_tokens, timeout=60, purpose='tldr.summary.native-settings',
                )
            except BaseException as exc:
                outcome['error'] = exc
            finally:
                with self._lock:
                    entry['worker_done'] = True
                    done.set()
                    if entry.get('detached') and self._inflight.get(request_id) is entry:
                        self._finish(request_id, entry, error='timeout')

        worker_context = contextvars.copy_context()
        threading.Thread(target=worker_context.run, args=(run,), name='tldr-llm', daemon=True).start()
        completed = done.wait(LLM_WAIT_SECONDS)
        if not completed:
            with self._lock:
                if entry.get('worker_done'):
                    completed = True
                else:
                    entry['detached'] = True
            if not completed:
                raise TimeoutError('timeout')
        if 'error' in outcome:
            exc = outcome['error']
            if isinstance(exc, TimeoutError):
                raise TimeoutError('timeout')
            raise exc
        return outcome.get('response')

    def generate(self, payload):
        digest = self._digest(payload)
        request_id = self._request_id(payload)
        if digest is None or request_id is None:
            raise ValueError('invalid_input')
        prior, owned = self._begin(request_id, digest)
        if not owned:
            return prior['result']
        try:
            inp, validated_request_id, assignment = self._validate(payload)
            if validated_request_id != request_id:
                raise ValueError('invalid_input')
            llm = self.ctx.llm
            if inp.get('schemaVersion') == 2:
                system = compose_v2_instructions(inp['mode'], inp['options'])
                max_tokens = int(V2_MAX_TOKENS.get(inp['options']['length'], 4096))
                user_payload = {key: inp[key] for key in ('mode', 'source', 'context', 'contextTruncated', 'tools')}
            else:
                system, max_tokens, user_payload = FIXED_INSTRUCTIONS, 4096, inp
            messages = [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': json.dumps(user_payload, separators=(',', ':'))},
            ]
            entry = self._inflight[request_id]
            response = self._complete(llm, messages, request_id, entry, max_tokens=max_tokens)
            text = _value(response, 'text')
            if not isinstance(text, str) or not text:
                raise RuntimeError('provider_error')
            actual = _actual_route(response)
            has_reported = isinstance(_value(response, 'provider'), str) or isinstance(_value(response, 'model'), str)
            attribution = 'host-reported' if has_reported and any(actual.values()) else 'host-reported-unavailable'
            result = {
                'apiVersion': 3, 'requestId': request_id, 'backendInstanceId': self.instance,
                'profile': self.profile, 'text': text, 'assignmentAtStart': assignment,
                'actual': actual, 'attribution': attribution,
                'usage': _sanitize_usage(_value(response, 'usage')),
            }
            self._finish(request_id, entry, result=result, digest=digest)
            return result
        except BaseException as exc:
            with self._lock:
                entry = self._inflight.get(request_id)
                if entry is not None and not entry.get('detached'):
                    self._finish(request_id, entry, error='timeout' if isinstance(exc, TimeoutError) else getattr(exc, 'args', [None])[0] if getattr(exc, 'args', None) else 'provider_error')
            raise
