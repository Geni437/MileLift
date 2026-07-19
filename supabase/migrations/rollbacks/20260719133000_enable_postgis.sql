-- Rollback for 20260719133000_enable_postgis.sql
-- Run LAST (after every table using extensions.geometry has been dropped) --
-- Postgres will refuse to drop the extension while activity_routes still has
-- columns of type extensions.geometry.
--
-- Not run automatically as part of any other rollback: dropping PostGIS is a
-- meaningful, deliberate action (it may be relied on by objects outside this
-- migration set), so this is left as an explicit, separate step.

drop extension if exists postgis;
