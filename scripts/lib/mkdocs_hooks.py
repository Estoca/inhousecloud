"""MkDocs hooks for the documentation site (mkdocs.yml, hooks:).

The pages in docs/ are written for GitHub first, so a relative link may leave docs/
(../scripts/ihc-backup.sh, ../AGENTS.md) or name a folder (runbooks/). On the site:

- a link to ../AGENTS.md becomes the site's own page for it (below);
- any other link out of docs/ becomes the file (or folder) on GitHub;
- a link to a folder of docs/ becomes its README.md or index.md, which MkDocs resolves;
- a link to nothing in the repository is a warning, which fails `mkdocs build --strict`.

AGENTS.md, at the root of the repository, is added to the site as agents.md, its links
(relative to the root) rewritten the same way.
"""

import logging
import os
import re

from mkdocs.structure.files import File

log = logging.getLogger("mkdocs.hooks.links")

REPO_URL = "https://github.com/Estoca/inhousecloud"
BRANCH = "main"

LINK = re.compile(r"(\]\(<?)([^)\s>]+)(>?(?:\s+\"[^\"]*\")?\))")
FENCE = re.compile(r"^\s*(```|~~~)")


def _paths(config):
    root = os.path.dirname(os.path.abspath(config["config_file_path"]))
    return root, os.path.abspath(config["docs_dir"])


def _within(path, base):
    return path == base or path.startswith(base + os.sep)


def _rewrite(markdown, src_dir, config, name):
    """The page's links, src_dir being the folder its relative links start from."""
    root, docs = _paths(config)

    def target_for(target):
        if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith(("#", "/")):
            return target
        path, sep, anchor = target.partition("#")
        resolved = os.path.normpath(os.path.join(src_dir, path))
        if not os.path.exists(resolved) or not _within(resolved, root):
            log.warning("%s: the link '%s' points to nothing in the repository", name, target)
            return target
        if resolved == os.path.join(root, "AGENTS.md"):
            # The site has its own page for it (on_files).
            resolved = os.path.join(docs, "agents.md")
        elif _within(resolved, docs):
            if os.path.isdir(resolved):
                index = next((i for i in ("index.md", "README.md") if os.path.isfile(os.path.join(resolved, i))), None)
                if index is None:
                    return f"{REPO_URL}/tree/{BRANCH}/{os.path.relpath(resolved, root)}"
                resolved = os.path.join(resolved, index)
            # MkDocs resolves it, relative to where the page sits in docs/.
            return os.path.relpath(resolved, os.path.join(docs, os.path.dirname(name))) + sep + anchor
        kind = "tree" if os.path.isdir(resolved) else "blob"
        return f"{REPO_URL}/{kind}/{BRANCH}/{os.path.relpath(resolved, root)}" + sep + anchor

    out, fenced = [], False
    for line in markdown.split("\n"):
        if FENCE.match(line):
            fenced = not fenced
        out.append(line if fenced else LINK.sub(lambda m: m.group(1) + target_for(m.group(2)) + m.group(3), line))
    return "\n".join(out)


def on_files(files, config):
    root, _ = _paths(config)
    with open(os.path.join(root, "AGENTS.md"), encoding="utf-8") as f:
        text = _rewrite(f.read(), root, config, "agents.md")
    files.append(File.generated(config, "agents.md", content=text))
    return files


def on_page_markdown(markdown, page, config, files):
    if page.file.generated_by:
        return markdown
    _, docs = _paths(config)
    src_dir = os.path.dirname(os.path.join(docs, page.file.src_uri))
    return _rewrite(markdown, src_dir, config, page.file.src_uri)
