from .backend.loader import load_runtime

register = load_runtime().register

__all__ = ['register']
