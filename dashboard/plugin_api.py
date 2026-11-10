from pathlib import Path
import hashlib
import importlib.util

try:
    from fastapi import APIRouter
    from fastapi.responses import JSONResponse
except ImportError:  # pragma: no cover - the Hermes dashboard supplies FastAPI
    APIRouter = None
    JSONResponse = None

try:
    from backend.loader import load_runtime
except ImportError:  # Dashboard loader imports this file as a standalone module.
    _root = Path(__file__).resolve().parents[1]
    _loader_path = _root / 'backend' / 'loader.py'
    _loader_key = '_hermes_tldr_loader_' + hashlib.sha256(str(_root).encode()).hexdigest()[:20]
    _spec = importlib.util.spec_from_file_location(_loader_key, _loader_path)
    if _spec is None or _spec.loader is None:
        raise ImportError('TL;DR runtime loader could not be loaded')
    _loader = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_loader)
    load_runtime = _loader.load_runtime

_runtime = load_runtime(Path(__file__).resolve().parents[1])


def service(*, discover=False):
    return _runtime.service_for_current(discover=discover)


def capabilities():
    selected = service(discover=True)
    if selected is None:
        return {'apiVersion': 3, 'pluginId': 'tldr', 'task': 'tldr_summary', 'backendInstanceId': None, 'profile': None, 'ready': False, 'reason': 'backend_unbound', 'assignment': {'state': 'unknown', 'provider': None, 'model': None, 'hasCustomEndpoint': False, 'observedAt': None, 'reason': 'read_failed'}}
    return selected.capabilities()


def _error(payload, exc):
    code = exc.args[0] if exc.args and isinstance(exc.args[0], str) else 'provider_error'
    # ``in_progress`` is an internal ledger state. Keep the public HTTP contract
    # frozen to its documented busy envelope while preserving the distinct state
    # in the service ledger for exact duplicate retries.
    public_code = 'busy' if code == 'in_progress' else code
    messages = {
        'invalid_input': 'The TL;DR request was invalid.',
        'scope_mismatch': 'The TL;DR backend scope changed; refresh and retry.',
        'task_unavailable': 'TL;DR is not registered on this profile.',
        'llm_unavailable': 'TL;DR model access is unavailable on this profile.',
        'assignment_unreadable': 'Could not check the TL;DR setting on this profile.',
        'busy': 'Another TL;DR request is already running.',
        'timeout': 'The selected model request timed out; the host may still be finishing it.',
        'provider_error': 'The selected model request failed.',
    }
    result = {'apiVersion': 3, 'error': {'code': public_code if public_code in messages else 'provider_error', 'message': messages.get(public_code, messages['provider_error']), 'retryable': code in {'busy', 'in_progress', 'timeout', 'provider_error', 'assignment_unreadable'}}}
    if isinstance(payload, dict) and isinstance(payload.get('requestId'), str):
        result['requestId'] = payload['requestId']
    return result


def generate(payload):
    selected = service(discover=True)
    if selected is None:
        return _error(payload, RuntimeError('setup_required'))
    try:
        return selected.generate(payload)
    except Exception as exc:
        return _error(payload, exc)


def history(payload):
    selected = service(discover=True)
    if selected is None:
        return _error(payload, RuntimeError('setup_required'))
    try:
        return selected.history(payload)
    except LookupError:
        return {'apiVersion': 3, 'error': {'code': 'not_found', 'message': 'This chat was not found on this Hermes profile.', 'retryable': False}}
    except Exception as exc:
        return _error(payload, exc)


# Hermes' dashboard loader imports this module and mounts its FastAPI router. It does not call a
# plugin-specific bind hook; the package register(ctx) path above is the supported context bridge.
router = APIRouter() if APIRouter is not None else None


if router is not None:
    @router.get('/capabilities')
    def _capabilities_route():
        return capabilities()

    @router.post('/generate')
    def _generate_route(payload: dict):
        result = generate(payload)
        if isinstance(result, dict) and isinstance(result.get('error'), dict):
            code = result['error'].get('code')
            status = 409 if code in {'busy', 'in_progress'} else 504 if code == 'timeout' else 503 if code in {'task_unavailable', 'llm_unavailable', 'assignment_unreadable'} else 400
            return JSONResponse(result, status_code=status)
        return result

    @router.post('/history')
    def _history_route(payload: dict):
        result = history(payload)
        if isinstance(result, dict) and isinstance(result.get('error'), dict):
            code = result['error'].get('code')
            return JSONResponse(result, status_code=404 if code == 'not_found' else 409 if code == 'scope_mismatch' else 400)
        return result
