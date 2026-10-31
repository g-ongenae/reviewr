import json
import pathlib
import sys
import uuid

repo = pathlib.Path(sys.argv[1])
if not (repo / '.git').is_dir():
    raise SystemExit('EXPORT_REPO must be an initialized git repository')
documents = json.load(sys.stdin)
# Validate all identifiers before touching existing exports.
if not isinstance(documents, list):
    raise ValueError('Expected an array of documents')
items = []
for document in documents:
    if not isinstance(document, dict) or not isinstance(document.get('content'), str):
        raise ValueError('Invalid document content')
    items.append((str(uuid.UUID(str(document['id']))), document['content']))
if len({identifier for identifier, _ in items}) != len(items):
    raise ValueError('Duplicate document ID')
directory = repo / 'documents'
directory.mkdir(exist_ok=True)
for identifier, content in items:
    (directory / (identifier + '.md')).write_text(content, encoding='utf-8')
keep = {identifier + '.md' for identifier, _ in items}
for path in directory.glob('*.md'):
    if path.name not in keep:
        path.unlink()
