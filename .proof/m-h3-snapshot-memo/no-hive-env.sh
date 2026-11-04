#!/bin/sh
exec env $(env | grep -o '^HIVE_[A-Za-z0-9_]*' | sed 's/^/-u /') "$@"
