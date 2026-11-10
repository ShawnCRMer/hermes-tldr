import hashlib
import importlib.util
import types
import sys
from pathlib import Path


def load_runtime(plugin_root=None):
    root = Path(plugin_root or Path(__file__).resolve().parents[1]).resolve()
    runtime_path = root / 'backend' / 'runtime.py'
    existing = sys.modules.get('backend.runtime')
    if existing is not None and Path(getattr(existing, '__file__', '')).resolve() == runtime_path:
        return existing
    digest = hashlib.sha256(str(root).encode()).hexdigest()[:20]
    package_key = '_hermes_tldr_runtime_' + digest
    key = package_key + '.runtime'
    loaded = sys.modules.get(key)
    if loaded is not None:
        return loaded
    package = sys.modules.get(package_key)
    if package is None:
        package = types.ModuleType(package_key)
        package.__path__ = [str(runtime_path.parent)]
        package.__package__ = package_key
        sys.modules[package_key] = package
    spec = importlib.util.spec_from_file_location(
        key, runtime_path
    )
    if spec is None or spec.loader is None:
        raise ImportError('TL;DR runtime could not be loaded')
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(key, None)
        raise
    return module
