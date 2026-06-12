#!/usr/bin/env python3
"""Structurally union two OpenAPI YAML files (merge-conflict resolution).

Usage: union-openapi.py BASE_WITH_PRIORITY OTHER OUTPUT
Copies OTHER's paths and ALL component sections (schemas, parameters,
responses, securitySchemes, ...) that BASE lacks. BASE wins on key clashes.
The app serves the committed file via include_str! — after any contract
merge, run this, then `npm run gen:api` and the full check suite.
"""
import sys, yaml

base = yaml.safe_load(open(sys.argv[1]))
other = yaml.safe_load(open(sys.argv[2]))
for k, v in other.get('paths', {}).items():
    base['paths'].setdefault(k, v)
bc = base.setdefault('components', {})
for section, entries in other.get('components', {}).items():
    dst = bc.setdefault(section, {})
    for k, v in entries.items():
        dst.setdefault(k, v)
open(sys.argv[3], 'w').write(yaml.safe_dump(base, allow_unicode=True, sort_keys=False, width=100))
print(f"unioned -> {sys.argv[3]}")
