"""Package the plugin as an .xpi (a zip with forward-slash paths) next to this script."""
import json
import pathlib
import zipfile

here = pathlib.Path(__file__).resolve().parent
version = json.loads((here / "manifest.json").read_text(encoding="utf-8"))["version"]
out = here / f"saved-search-folders-{version}.xpi"

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as xpi:
    for name in ["manifest.json", "bootstrap.js", "searchFolders.js"]:
        xpi.write(here / name, name)

print(out)
