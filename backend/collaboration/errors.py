class RuntimeFailure(RuntimeError):
    def __init__(self, code: str, *, outcome_unknown: bool = False):
        super().__init__(code)
        self.code = code
        self.outcome_unknown = outcome_unknown


class RunCancelled(RuntimeError):
    pass
