"""插件自有状态的原子保存和跨进程锁；不替代 Core 工程文件。"""
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import hashlib
import json
import os
import tempfile


class PluginError(Exception):
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details


def now():
    return datetime.now(timezone.utc).isoformat()


def identity(value):
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def load(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    # 同目录替换，异常时留下临时文件供诊断，不清理用户产物。
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                     prefix=".pending-", suffix=".json", delete=False) as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = stream.name
    os.replace(temporary, path)


@contextmanager
def exclusive(path):
    """锁随进程退出释放；锁文件可以长期保留，不使用 PID 猜测所有权。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if path.stat().st_size == 0:
            stream.write(b"\0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise PluginError("busy", "此会话或工程仍有操作在运行，请在原聊天查看进度。") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def resolve(value, base):
    if not isinstance(value, str) or not value.strip():
        raise PluginError("invalid_path", "目录或文件路径不能为空。")
    path = Path(value).expanduser()
    return (path if path.is_absolute() else base / path).resolve()


def within(path, roots):
    return any(path == root or root in path.parents for root in roots)


def admit(value, base, roots, *, directory=False):
    path = resolve(value, base)
    if not within(path, roots):
        raise PluginError("directory_access_required", "路径不在本会话或配置允许的范围内。",
                          path=str(path), allowed_roots=list(map(str, roots)))
    if directory and not path.is_dir():
        raise PluginError("directory_missing", "目录不存在。", path=str(path))
    return path
