-- Evolution GO needs two databases (auth + users). The first one (evogo_auth) is created by
-- POSTGRES_DB in docker-compose.yml; this script runs once on first start of its Postgres volume.
CREATE DATABASE evogo_users;
