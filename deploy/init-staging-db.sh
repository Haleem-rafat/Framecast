#!/bin/sh
# Runs once, on an empty data directory. The `framecast` database is created
# by POSTGRES_DB; staging's is created here so both live in one instance.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
	CREATE DATABASE framecast_staging;
EOSQL
