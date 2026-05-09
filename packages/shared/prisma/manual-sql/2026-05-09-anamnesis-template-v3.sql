-- ============================================================================
-- Migration manual — 2026-05-09 — AnamnesisTemplate V3
-- ============================================================================
-- V3 = V2 + campo "sex" em Dados Gerais + section "pregnancy" condicional
-- (show_if: sex == "Feminino"). Todos os campos continuam opcionais.
--
-- IDEMPOTENTE: cria/atualiza V3 ativo e desativa anteriores.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  t            RECORD;
  v3_schema    JSONB;
  existing_id  TEXT;
  next_version INT;
BEGIN
  v3_schema := '{
    "sections": [
      {"id":"general","title":"Dados Gerais","questions":[
        {"id":"sex","type":"select","label":"Sexo biologico","options":["Feminino","Masculino","Outro","Prefiro nao informar"],"required":false},
        {"id":"height","type":"number","label":"Altura (cm)","required":false},
        {"id":"weight","type":"number","label":"Peso (kg)","required":false},
        {"id":"blood_type","type":"select","label":"Tipo sanguineo","options":["A+","A-","B+","B-","AB+","AB-","O+","O-","Nao sei"],"required":false}
      ]},
      {"id":"medical_history","title":"Historico Medico","questions":[
        {"id":"chronic_diseases","type":"multiselect","label":"Possui alguma doenca cronica?","options":["Diabetes","Hipertensao","Doenca cardiaca","Doenca renal","Doenca hepatica","Problema de tireoide","Epilepsia","Asma","Anemia","Outra","Nenhuma"],"required":false},
        {"id":"chronic_disease_other","type":"text","label":"Se outra, especifique","required":false},
        {"id":"had_surgery","type":"boolean","label":"Ja fez alguma cirurgia?","required":false},
        {"id":"surgeries_detail","type":"textarea","label":"Se sim, qual(is)?","required":false},
        {"id":"was_hospitalized","type":"boolean","label":"Esteve hospitalizado nos ultimos 2 anos?","required":false},
        {"id":"hospitalizations_detail","type":"textarea","label":"Se sim, motivo?","required":false}
      ]},
      {"id":"allergies_meds","title":"Alergias e Medicamentos","questions":[
        {"id":"allergies_known","type":"boolean","label":"Possui alergias conhecidas?","required":false},
        {"id":"allergies_list","type":"textarea","label":"Se sim, quais? (medicamentos, latex, anestesicos, etc.)","required":false},
        {"id":"uses_medication","type":"boolean","label":"Usa algum medicamento atualmente?","required":false},
        {"id":"medications_current","type":"textarea","label":"Se sim, quais? (nome, dose, frequencia)","required":false},
        {"id":"uses_anticoagulant","type":"boolean","label":"Usa anticoagulante (AAS, varfarina, rivaroxabana, etc.)?","required":false}
      ]},
      {"id":"lifestyle","title":"Habitos e Estilo de Vida","questions":[
        {"id":"smoker","type":"select","label":"Fuma?","options":["Nunca","Ex-fumante","Fumante ocasional","Fumante diario"],"required":false},
        {"id":"alcohol","type":"select","label":"Consome alcool?","options":["Nao","Socialmente","Frequentemente","Diariamente"],"required":false},
        {"id":"uses_drugs","type":"boolean","label":"Faz uso de drogas recreativas?","required":false},
        {"id":"snoring","type":"boolean","label":"Costuma roncar ou tem apneia?","required":false}
      ]},
      {"id":"dental_history","title":"Historico Odontologico","questions":[
        {"id":"last_visit","type":"select","label":"Quando foi sua ultima consulta odontologica?","options":["Menos de 6 meses","6 a 12 meses","1 a 2 anos","Mais de 2 anos","Nunca"],"required":false},
        {"id":"brushing_frequency","type":"select","label":"Frequencia de escovacao","options":["1x ao dia","2x ao dia","3x ao dia","Mais de 3x ao dia","Irregular"],"required":false},
        {"id":"floss_use","type":"boolean","label":"Usa fio dental diariamente?","required":false},
        {"id":"uses_mouthwash","type":"boolean","label":"Usa enxaguante bucal?","required":false},
        {"id":"had_orthodontic","type":"boolean","label":"Ja usou aparelho ortodontico?","required":false},
        {"id":"had_extraction","type":"boolean","label":"Ja extraiu algum dente?","required":false},
        {"id":"anesthesia_reaction","type":"boolean","label":"Ja teve reacao a anestesia odontologica?","required":false},
        {"id":"anesthesia_reaction_detail","type":"textarea","label":"Se sim, descreva","required":false}
      ]},
      {"id":"oral_health","title":"Saude Bucal Atual","questions":[
        {"id":"pain_current","type":"boolean","label":"Sente dor em algum dente agora?","required":false},
        {"id":"pain_description","type":"textarea","label":"Se sim, descreva a dor e localizacao","required":false},
        {"id":"gum_bleeding","type":"boolean","label":"Suas gengivas sangram ao escovar?","required":false},
        {"id":"bad_breath","type":"boolean","label":"Tem mau halito persistente?","required":false},
        {"id":"dry_mouth","type":"boolean","label":"Sente boca seca com frequencia?","required":false},
        {"id":"mouth_sores","type":"boolean","label":"Aparecem feridas/aftas na boca com frequencia?","required":false},
        {"id":"bruxism","type":"boolean","label":"Aperta ou range os dentes (bruxismo)?","required":false},
        {"id":"jaw_pain","type":"boolean","label":"Sente estalos ou dor na ATM (mandibula)?","required":false},
        {"id":"sensitivity","type":"multiselect","label":"Sensibilidade a:","options":["Frio","Calor","Doces","Pressao","Nenhuma"],"required":false}
      ]},
      {"id":"pregnancy","title":"Gestacao e Hormonios","show_if":{"question_id":"sex","equals":"Feminino"},"questions":[
        {"id":"pregnant","type":"boolean","label":"Esta gestante?","required":false},
        {"id":"pregnancy_weeks","type":"number","label":"Se sim, quantas semanas?","required":false},
        {"id":"breastfeeding","type":"boolean","label":"Esta amamentando?","required":false},
        {"id":"uses_contraceptive","type":"boolean","label":"Usa anticoncepcional?","required":false},
        {"id":"menopause","type":"boolean","label":"Esta na menopausa?","required":false}
      ]},
      {"id":"family_history","title":"Historico Familiar","questions":[
        {"id":"family_diseases","type":"multiselect","label":"Parentes proximos com:","options":["Diabetes","Hipertensao","Cancer","Doenca cardiaca","Problemas dentarios graves","Nenhum"],"required":false}
      ]},
      {"id":"notes","title":"Observacoes Livres","questions":[
        {"id":"patient_notes","type":"textarea","label":"Algo mais que considera importante informar?","required":false}
      ]}
    ]
  }'::jsonb;

  FOR t IN SELECT id FROM "Tenant" LOOP
    SELECT id INTO existing_id FROM "AnamnesisTemplate"
    WHERE tenant_id = t.id AND version >= 3 ORDER BY version DESC LIMIT 1;

    IF existing_id IS NOT NULL THEN
      UPDATE "AnamnesisTemplate"
      SET schema=v3_schema, active=TRUE,
          notes='Template V3 odontologico — 9 secoes, todos opcionais, gestacao condicional ao sexo',
          updated_at=NOW()
      WHERE id=existing_id;
      UPDATE "AnamnesisTemplate" SET active=FALSE
      WHERE tenant_id=t.id AND id<>existing_id;
      RAISE NOTICE 'Tenant %: V3 atualizado (id=%)', t.id, existing_id;
    ELSE
      SELECT COALESCE(MAX(version),2)+1 INTO next_version
      FROM "AnamnesisTemplate" WHERE tenant_id=t.id;
      INSERT INTO "AnamnesisTemplate" (id,tenant_id,version,schema,active,notes,created_at,updated_at)
      VALUES (gen_random_uuid()::text, t.id, next_version, v3_schema, TRUE,
              'Template V3 odontologico — 9 secoes, todos opcionais, gestacao condicional ao sexo',
              NOW(), NOW());
      UPDATE "AnamnesisTemplate" SET active=FALSE
      WHERE tenant_id=t.id AND version<>next_version;
      RAISE NOTICE 'Tenant %: V3 criado como versao %', t.id, next_version;
    END IF;
  END LOOP;
END $$;

COMMIT;
