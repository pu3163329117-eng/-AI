"""Local-only DeepSeek Harness collaboration bridge.

This package owns its database and runtime lifecycle.  It intentionally does
not import the learner database models or the student-facing AI provider.
"""

from .controller import controller

__all__ = ["controller"]
