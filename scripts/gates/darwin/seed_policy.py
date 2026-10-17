import hashlib
import json
from pathlib import PurePosixPath
import re
from urllib.parse import urlsplit


REGISTRY = 'https://registry.npmjs.org/'
PATH = re.compile(r'^/(?:@[a-z0-9._~-]+/)?[a-z0-9._~+-]+(?:/-/[a-zA-Z0-9._~+-]+[.]tgz)?$')
FORBIDDEN_HEADER = re.compile(r'authorization|cookie|token|secret|credential|api[-_]?key', re.I)
SAFE_HEADERS = {'reqHeaders': {'accept', 'accept-encoding', 'user-agent', 'cache-control', 'pragma'}, 'resHeaders': {'cache-control', 'content-type', 'date', 'etag', 'last-modified', 'content-encoding', 'content-length', 'vary', 'server', 'age', 'connection', 'cf-cache-status', 'cf-ray', 'x-served-by', 'x-cache', 'x-cache-hits', 'x-timer', 'access-control-allow-origin'}}


def canonical_url(value, tarball=False):
    if not isinstance(value, str) or not value.startswith(REGISTRY) or any(ch in value for ch in ('%', '?', '#', '\\')) or any(ord(ch) <= 32 or ord(ch) >= 127 for ch in value):
        raise ValueError('noncanonical registry URL refused')
    url = urlsplit(value)
    if url.scheme != 'https' or url.netloc != 'registry.npmjs.org' or not PATH.fullmatch(url.path) or (tarball and not url.path.endswith('.tgz')):
        raise ValueError('noncanonical registry URL refused')
    if value != REGISTRY[:-1] + url.path:
        raise ValueError('noncanonical registry URL refused')
    return value


def validate_lock(lock):
    if lock.get('lockfileVersion') != 3 or not isinstance(lock.get('packages'), dict) or '' not in lock['packages']:
        raise ValueError('unsupported seed lock schema')
    for name, row in lock['packages'].items():
        if not isinstance(row, dict) or row.get('link') or row.get('workspaces'):
            raise ValueError('local or workspace dependency refused')
        for field in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
            for spec in row.get(field, {}).values():
                if not isinstance(spec, str) or re.search(r'[:/\\]', spec):
                    raise ValueError('nonregistry dependency spec refused')
        if not name:
            if 'resolved' in row:
                raise ValueError('root lock entry must not resolve externally')
            continue
        if not name.startswith('node_modules/') or '..' in PurePosixPath(name).parts or PurePosixPath(name).as_posix() != name:
            raise ValueError('nonregistry lock entry refused')
        resolved = canonical_url(row.get('resolved'), tarball=True)
        integrity = row.get('integrity')
        if not isinstance(integrity, str) or not re.fullmatch(r'sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}', integrity):
            raise ValueError('registry integrity required')
        package = name.rsplit('node_modules/', 1)[-1]
        leaf = package.rsplit('/', 1)[-1]
        if resolved != REGISTRY + package + '/-/' + leaf + '-' + str(row.get('version')) + '.tgz':
            raise ValueError('lock tarball path does not match package and version')
    return True


def audit_index(cache):
    directory = cache / 'index-v5'
    if not directory.is_dir() or directory.is_symlink():
        raise ValueError('cache index absent or redirected')
    count = 0
    for path in sorted(directory.rglob('*')):
        if path.is_symlink():
            raise ValueError('cache index redirected')
        if not path.is_file():
            continue
        for line in path.read_bytes().splitlines():
            if not line:
                continue
            parts = line.split(b'\t', 1)
            if len(parts) != 2 or hashlib.sha1(parts[1]).hexdigest().encode() != parts[0]:
                raise ValueError('cache index record corrupt')
            row = json.loads(parts[1])
            prefix = 'make-fetch-happen:request-cache:'
            key = row.get('key')
            if not isinstance(key, str) or not key.startswith(prefix):
                raise ValueError('unapproved cache index key')
            canonical_url(key[len(prefix):])
            metadata = row.get('metadata')
            if not isinstance(metadata, dict) or set(metadata) - {'url', 'reqHeaders', 'resHeaders', 'time', 'options'}:
                raise ValueError('cache metadata absent')
            canonical_url(metadata.get('url'))
            if metadata['url'] != key[len(prefix):] or not isinstance(metadata.get('options', {}), dict) or set(metadata.get('options', {})) - {'compress'}:
                raise ValueError('cache metadata policy mismatch')
            if 'compress' in metadata.get('options', {}) and type(metadata['options']['compress']) is not bool:
                raise ValueError('cache metadata options malformed')
            for field in ('reqHeaders', 'resHeaders'):
                headers = metadata.get(field, {})
                if not isinstance(headers, dict):
                    raise ValueError('cache headers malformed')
                for name, value in headers.items():
                    if not isinstance(name, str) or name.lower() not in SAFE_HEADERS[field] or FORBIDDEN_HEADER.search(name) or not isinstance(value, str) or any(ord(ch) < 32 for ch in value) or re.search(r'authorization|bearer\s|(?:token|secret|api[-_]?key)\s*[:=]', value, re.I):
                        raise ValueError('credential-bearing cache header refused')
                    if value.startswith(('http:', 'https:')):
                        canonical_url(value)
            count += 1
    if not count:
        raise ValueError('empty cache index')
    return count

