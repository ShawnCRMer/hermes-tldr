import contextvars
import secrets
import threading
from pathlib import Path

_instances = {}
_lock = threading.RLock()
_discovery_lock = threading.Lock()
_discovery_scope = contextvars.ContextVar('tldr_discovery_scope', default=False)


def _profile_key(ctx):
    # PluginManager enters the profile-home scope before calling register(ctx). The same
    # supported scope is restored by the dashboard request middleware, so this key remains
    # authoritative across the plugin and dashboard entry points.
    from hermes_constants import get_hermes_home
    return str(Path(get_hermes_home()).resolve())


def _profile_name(ctx):
    value = getattr(ctx, 'profile_name', None) or getattr(ctx, 'profile', None)
    return str(value).strip() if value else _profile_key(ctx)


def _current_profile_key():
    from hermes_constants import get_hermes_home
    return str(Path(get_hermes_home()).resolve())


def bind(ctx):
    key = _profile_key(ctx)
    with _lock:
        runtime = _instances.get(key)
        if runtime is None or runtime.get('ctx') is not ctx:
            runtime = {'ctx': ctx, 'profile': _profile_name(ctx), 'instance': secrets.token_hex(12), 'service': None}
            _instances[key] = runtime
        if runtime['service'] is None:
            from .service import TldrService
            runtime['service'] = TldrService(ctx, runtime['profile'], runtime['instance'], registration_ready=False)
        return runtime


def service_for(ctx):
    runtime = _instances.get(_profile_key(ctx))
    return runtime['service'] if runtime else None


def _discover_current_profile():
    """Use Hermes' supported, current-home discovery path when the dashboard starts cold.

    Dashboard imports intentionally do not manufacture a PluginContext or instantiate PluginLlm.
    ``discover_plugins`` owns enable/trust/isolation gates and enters the manager's profile-home
    scope before invoking this plugin's supported ``register(ctx)`` hook. The context guard keeps a
    plugin-load re-entry from recursively asking the host to discover itself.
    """
    if _discovery_scope.get():
        return
    token = _discovery_scope.set(True)
    try:
        from hermes_cli.plugins import discover_plugins
        discover_plugins()
    except Exception:
        # Capabilities must remain fail-closed when the host cannot discover this profile.
        return
    finally:
        _discovery_scope.reset(token)


def service_for_current(*, discover=False):
    """Return only the service for the host's current profile scope.

    Dashboard imports do not receive ``ctx``. Hermes binds the effective profile home around plugin
    loading and request dispatch, so prefer that exact key. If that authoritative scope is unavailable,
    fail closed instead of guessing from whichever profile happened to load first.
    """
    try:
        key = _current_profile_key()
    except Exception:
        key = ''
    with _lock:
        runtime = _instances.get(key)
        if runtime is not None:
            return runtime['service']
    if discover and not _discovery_scope.get():
        # Serialize discovery without holding the instance lock: the supported register(ctx) hook runs
        # on Hermes' loader worker and must acquire this module's instance lock to publish its service.
        with _discovery_lock:
            with _lock:
                runtime = _instances.get(key)
                if runtime is not None:
                    return runtime['service']
            _discover_current_profile()
            with _lock:
                runtime = _instances.get(key)
                if runtime is not None:
                    return runtime['service']
    return None


def unbind(ctx):
    with _lock:
        key = _profile_key(ctx)
        runtime = _instances.get(key)
        if runtime is not None and runtime.get('ctx') is ctx:
            _instances.pop(key, None)


def register(ctx):
    runtime = bind(ctx)
    register_task = getattr(ctx, 'register_auxiliary_task', None)
    registered = False
    if callable(register_task):
        try:
            result = register_task('tldr_summary', display_name='TL;DR', description='Summarize the latest response without changing chat models.')
            registered = result is not False
        except Exception:
            registered = False
    runtime['service'].mark_registration(registered)
    on_unload = getattr(ctx, 'on_unload', None)
    if callable(on_unload):
        on_unload(lambda: unbind(ctx))
    return runtime['service']
