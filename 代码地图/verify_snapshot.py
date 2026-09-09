"""Read-only validation for this dated code map. Run from any working directory."""
from pathlib import Path
import hashlib
import json
import re
import sys


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    base = Path(__file__).resolve().parent
    root = base.parent
    snapshot = json.loads((base / 'snapshot.json').read_text(encoding='utf-8'))
    errors = []
    stale = []
    for item in snapshot['files']:
        file = root / item['path']
        if not file.is_file():
            errors.append('Missing source: ' + item['path'])
        elif digest(file.read_bytes()) != item['sha256']:
            stale.append(item['path'])
    for item in snapshot.get('expectedAbsent', []):
        if (root / item).exists():
            stale.append('Previously absent, now present: ' + item)
    manifest_path = base / '来源/2026-09-09/manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    for item in manifest['records']:
        file = manifest_path.parent / item['file']
        if not file.is_file() or digest(file.read_bytes()) != item['bodySha256']:
            errors.append('Archive missing or modified: ' + item['file'])
    for item in manifest.get('images', []):
        file = manifest_path.parent.parent / item['file']
        if not file.is_file() or digest(file.read_bytes()) != item['sha256']:
            errors.append('Archive image missing or modified: ' + item['file'])
    guides = list(base.glob('*.md')) + [base / '来源/README.md']
    claude_entry = root / 'CLAUDE.md'
    if not claude_entry.is_file():
        errors.append('Missing Claude entry: CLAUDE.md')
    else:
        for include in re.findall(r'^@(.+)$', claude_entry.read_text(encoding='utf-8'), re.M):
            if not (include.startswith('./') or re.match(r'^[a-zA-Z0-9._-]', include)):
                errors.append('Unsupported CLAUDE include prefix: ' + include)
            if not (root / include).is_file():
                errors.append('Missing CLAUDE include: ' + include)
    for guide in guides:
        text = guide.read_text(encoding='utf-8')
        for href in re.findall(r'(?<!!)\[[^\]]*\]\(([^)]+)\)', text):
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', href) or href.startswith('#'):
                continue
            target = (guide.parent / href.split('#', 1)[0]).resolve()
            if not target.exists():
                errors.append(f'Broken guide link: {guide.name} -> {href}')
        for source, line in re.findall(r'`((?:src|desktop|runtime|adapters|scripts)/[^`\s:]+)(?::(\d+))?`', text):
            target = root / source
            if not target.exists():
                errors.append(f'Missing inline path: {guide.name} -> {source}')
            elif line and target.is_file():
                count = len(target.read_text(encoding='utf-8', errors='replace').splitlines())
                if int(line) > count:
                    errors.append(f'Line beyond file: {source}:{line}')
    for value in errors:
        print('ERROR: ' + value)
    for value in stale:
        print('STALE: ' + value)
    print(json.dumps({'sourceFiles': len(snapshot['files']), 'archivedPages': len(manifest['records']), 'archivedImages': len(manifest.get('images', [])), 'guideFiles': len(guides), 'errors': len(errors), 'staleSources': len(stale), 'productTestsRun': False}, ensure_ascii=True))
    if stale:
        print('Re-read changed evidence and revise conclusions before refreshing hashes. Hash equality is not a behavior test.')
    return 1 if errors else 2 if stale else 0


if __name__ == '__main__':
    sys.exit(main())
