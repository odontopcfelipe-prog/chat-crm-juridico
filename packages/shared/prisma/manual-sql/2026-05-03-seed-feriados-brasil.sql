-- Seed de feriados nacionais brasileiros + festividades dentais.
--
-- Fase 25 (Onda 5e v8) — popular tabela "Holiday" pra agenda renderizar
-- numero do dia em vermelho automaticamente nos dias nao uteis.
--
-- COMO RODAR (na VPS):
--   docker exec -i chatcrm_postgres psql -U chatcrm -d chatcrm < 2026-05-03-seed-feriados-brasil.sql
--
-- IMPORTANTE: o tenant_id eh deixado NULL porque feriados nacionais valem
-- pra TODOS os tenants. Se voce quiser feriados especificos do tenant
-- (ex: "Aniversario da clinica"), insira com tenant_id preenchido.
--
-- Dates de pascoa (movel) sao por ANO — adiciono 2026 e 2027 pra ja garantir
-- cobertura. Pra anos seguintes, tem que adicionar manualmente porque a
-- pascoa varia (nao da pra usar recurring_yearly = true).

-- Limpa duplicatas previas (idempotente — pode rodar varias vezes sem
-- gerar feriado duplicado)
DELETE FROM "Holiday" WHERE name IN (
  'Confraternização Universal',
  'Tiradentes',
  'Dia do Trabalho',
  'Independência do Brasil',
  'Nossa Senhora Aparecida',
  'Finados',
  'Proclamação da República',
  'Consciência Negra',
  'Natal',
  'Carnaval',
  'Sexta-feira Santa',
  'Corpus Christi'
);

-- ─── Feriados FIXOS (recorrencia anual via recurring_yearly = true) ───
-- A data eh do ano corrente mas o flag recurring_yearly = true faz o
-- frontend matchear pelo MM-DD em qualquer ano.
INSERT INTO "Holiday" (id, tenant_id, date, name, recurring_yearly, created_at, updated_at) VALUES
  (gen_random_uuid(), NULL, '2026-01-01', 'Confraternização Universal', true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-04-21', 'Tiradentes',                 true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-05-01', 'Dia do Trabalho',            true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-09-07', 'Independência do Brasil',    true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-10-12', 'Nossa Senhora Aparecida',    true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-11-02', 'Finados',                    true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-11-15', 'Proclamação da República',   true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-11-20', 'Consciência Negra',          true, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-12-25', 'Natal',                      true, NOW(), NOW());

-- ─── Feriados MOVEIS — 2026 (data exata, recurring_yearly = false) ───
-- Pascoa 2026: 5 de abril
INSERT INTO "Holiday" (id, tenant_id, date, name, recurring_yearly, created_at, updated_at) VALUES
  (gen_random_uuid(), NULL, '2026-02-17', 'Carnaval',          false, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-04-03', 'Sexta-feira Santa', false, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2026-06-04', 'Corpus Christi',    false, NOW(), NOW());

-- ─── Feriados MOVEIS — 2027 (data exata) ───
-- Pascoa 2027: 28 de marco
INSERT INTO "Holiday" (id, tenant_id, date, name, recurring_yearly, created_at, updated_at) VALUES
  (gen_random_uuid(), NULL, '2027-02-09', 'Carnaval',          false, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2027-03-26', 'Sexta-feira Santa', false, NOW(), NOW()),
  (gen_random_uuid(), NULL, '2027-05-27', 'Corpus Christi',    false, NOW(), NOW());

-- Verificacao final
SELECT
  CASE WHEN recurring_yearly THEN 'ANUAL' ELSE TO_CHAR(date, 'YYYY') END AS tipo,
  TO_CHAR(date, 'DD/MM') AS dia_mes,
  name
FROM "Holiday"
WHERE tenant_id IS NULL
ORDER BY recurring_yearly DESC, date ASC;
