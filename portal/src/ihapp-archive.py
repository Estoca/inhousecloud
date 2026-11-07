"""Trusted archive reader: inspect ALL headers before reading any member's bytes.

Never use extract/extractall: links, devices and tar path interpretation cannot write
to the filesystem. Node writes the resulting regular-file map into a fresh tree.
"""
import base64
import json
import re
import sys
import tarfile


def read_archive(filename):
    with tarfile.open(filename, 'r:gz') as archive:
        members = []
        names = set()
        total = 0
        for index, member in enumerate(archive):
            if index >= 1000:
                return dict(code='IHC-FILES-LIMIT', error='Too many archive entries.')
            name = member.name.rstrip('/') if member.isdir() else member.name
            # Common tar -C tree -czf upload . starts with ./ and a root directory.
            if name in ('.', './') and member.isdir():
                continue
            if name.startswith('./'):
                name = name[2:]
            parts = name.split('/')
            if (not name or len(name) > 300 or re.search(r'[\\\x00-\x1f\x7f]', name)
                    or re.match(r'^[A-Za-z]:', name)
                    or any(p in ('', '.', '..') or p.lower() == '.git' for p in parts)):
                return dict(code='IHC-FILES-PATH', error='Unsafe archive path.')
            if any(p == '.env' or (p.startswith('.env.') and p != '.env.example') for p in parts):
                return dict(code='IHC-FILES-ENV', error='Environment files are refused.')
            if not (member.isfile() or member.isdir()) or member.issparse():
                return dict(code='IHC-FILES-ARCHIVE', error='Only regular files and directories are accepted.')
            if name in names:
                return dict(code='IHC-FILES-PATH', error='Duplicate archive path.')
            names.add(name)
            if member.isfile():
                total += member.size
                members.append((name, member))
                if len(members) > 300 or member.size > 262144 or total > 25 * 1024 * 1024:
                    return dict(code='IHC-FILES-LIMIT', error='Expanded archive exceeds the tree limits.')
        return [dict(path=name, content=base64.b64encode(archive.extractfile(member).read()).decode('ascii'))
                for name, member in members]


try:
    print(json.dumps(read_archive(sys.argv[1])))
except Exception:
    print(json.dumps(dict(code='IHC-FILES-ARCHIVE', error='Invalid tar.gz archive.')))
