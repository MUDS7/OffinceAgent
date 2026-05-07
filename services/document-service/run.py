from pathlib import Path
import os
import sys

LOCAL_PACKAGES = Path(__file__).resolve().parent / ".packages"
if LOCAL_PACKAGES.exists():
    sys.path.insert(0, str(LOCAL_PACKAGES))

import uvicorn


if __name__ == "__main__":
    reload_enabled = os.getenv("OFFICE_AGENT_DOCUMENT_SERVICE_RELOAD") == "1"
    uvicorn.run("app.main:app", host="127.0.0.1", port=8765, reload=reload_enabled)
