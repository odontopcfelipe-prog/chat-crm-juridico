-- Migração: Foto de perfil de usuário
-- Executa de forma idempotente (pode rodar múltiplas vezes sem erro)

-- Adiciona coluna profile_picture_url na tabela User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profile_picture_url" TEXT;
