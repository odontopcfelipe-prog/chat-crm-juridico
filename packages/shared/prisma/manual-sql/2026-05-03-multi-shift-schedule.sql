-- Refatora UserSchedule pra suportar multiplos turnos no mesmo dia.
--
-- Fase 25 (Onda 5e v10) — Antes: 1 entrada por (user_id, day_of_week) com
-- start/end + opcional lunch_start/lunch_end. Agora: N entradas pelo mesmo
-- dia (ex: Manha 08-12, Tarde 14-18, Plantao 19-22) — config mais flexivel.
--
-- COMO RODAR (na VPS):
--   docker exec -i chatcrm_postgres psql -U chatcrm -d chatcrm < 2026-05-03-multi-shift-schedule.sql
--
-- COMPATIBILIDADE: registros antigos com lunch_start/lunch_end continuam
-- funcionando — backend respeita ambos formatos. UI nova vai migrar pra
-- 2 turnos quando user editar.

-- 1. Remove constraint unique antiga (chave era user_id+day_of_week).
--    Nome do constraint segue convencao Prisma: <Table>_<col1>_<col2>_key
ALTER TABLE "UserSchedule" DROP CONSTRAINT IF EXISTS "UserSchedule_user_id_day_of_week_key";

-- 2. Garante indice nao-unico pra perfomance de queries (findMany por user/dia)
CREATE INDEX IF NOT EXISTS "UserSchedule_user_id_day_of_week_idx" ON "UserSchedule" ("user_id", "day_of_week");

-- 3. Adiciona colunas novas (label opcional + sort_order)
ALTER TABLE "UserSchedule" ADD COLUMN IF NOT EXISTS "label" TEXT;
ALTER TABLE "UserSchedule" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
