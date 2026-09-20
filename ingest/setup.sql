-- Database structure for the port dashboard.
-- Schemas + registry tables (raw and mart tables are created by ingest/portwatch_load.py and the Mage pipelines).
-- Idempotent: safe to run against a live database.
-- Recovery: run this file, then the seed script or pipelines.
CREATE SCHEMA IF NOT EXISTS port_raw;
CREATE SCHEMA IF NOT EXISTS port_mart;

--
-- PostgreSQL database dump
--

\restrict lB20j4tVJK71tUDkQMqtZ9Ry5PkDvMpcqEiEW4Qm0DWt0Ux3NpdOkOcuOuYQ8Ft

-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: registry; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS registry;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: assets; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE IF NOT EXISTS registry.assets (
    asset_key text NOT NULL,
    schema_name text NOT NULL,
    table_name text NOT NULL,
    layer text NOT NULL,
    description text,
    source_system text,
    source_detail text,
    grain text,
    owner text,
    area_code text,
    pipeline_uuid text,
    block_uuid text,
    last_run_at timestamp with time zone,
    last_row_count bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: edges; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE IF NOT EXISTS registry.edges (
    from_asset text NOT NULL,
    to_asset text NOT NULL,
    edge_type text DEFAULT 'feeds'::text NOT NULL
);


--
-- Name: fields; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE IF NOT EXISTS registry.fields (
    asset_key text NOT NULL,
    field_name text NOT NULL,
    data_type text,
    description text,
    unit text,
    is_nullable boolean
);


--
-- Name: quality_checks; Type: TABLE; Schema: registry; Owner: -
--

CREATE TABLE IF NOT EXISTS registry.quality_checks (
    asset_key text NOT NULL,
    check_name text NOT NULL,
    passed boolean NOT NULL,
    detail text,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assets assets_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'assets_pkey') THEN
        ALTER TABLE ONLY registry.assets
    ADD CONSTRAINT assets_pkey PRIMARY KEY (asset_key);
    END IF;
END $$;


--
-- Name: edges edges_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edges_pkey') THEN
        ALTER TABLE ONLY registry.edges
    ADD CONSTRAINT edges_pkey PRIMARY KEY (from_asset, to_asset, edge_type);
    END IF;
END $$;


--
-- Name: fields fields_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fields_pkey') THEN
        ALTER TABLE ONLY registry.fields
    ADD CONSTRAINT fields_pkey PRIMARY KEY (asset_key, field_name);
    END IF;
END $$;


--
-- Name: quality_checks quality_checks_pkey; Type: CONSTRAINT; Schema: registry; Owner: -
--

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quality_checks_pkey') THEN
        ALTER TABLE ONLY registry.quality_checks
    ADD CONSTRAINT quality_checks_pkey PRIMARY KEY (asset_key, check_name);
    END IF;
END $$;


--
-- Name: fields fields_asset_key_fkey; Type: FK CONSTRAINT; Schema: registry; Owner: -
--

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fields_asset_key_fkey') THEN
        ALTER TABLE ONLY registry.fields
    ADD CONSTRAINT fields_asset_key_fkey FOREIGN KEY (asset_key) REFERENCES registry.assets(asset_key) ON DELETE CASCADE;
    END IF;
END $$;


--
-- Name: quality_checks quality_checks_asset_key_fkey; Type: FK CONSTRAINT; Schema: registry; Owner: -
--

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quality_checks_asset_key_fkey') THEN
        ALTER TABLE ONLY registry.quality_checks
    ADD CONSTRAINT quality_checks_asset_key_fkey FOREIGN KEY (asset_key) REFERENCES registry.assets(asset_key) ON DELETE CASCADE;
    END IF;
END $$;


--
-- PostgreSQL database dump complete
--

\unrestrict lB20j4tVJK71tUDkQMqtZ9Ry5PkDvMpcqEiEW4Qm0DWt0Ux3NpdOkOcuOuYQ8Ft

