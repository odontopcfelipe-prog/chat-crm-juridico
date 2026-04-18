-- Migração: MinIO → Filesystem local
-- Executa de forma idempotente (pode rodar múltiplas vezes sem erro)

-- 1. Torna s3_key nullable (mídias novas não precisarão de chave S3)
ALTER TABLE "Media" ALTER COLUMN "s3_key" DROP NOT NULL;

-- 2. Adiciona coluna file_path para o path relativo no filesystem
ALTER TABLE "Media" ADD COLUMN IF NOT EXISTS "file_path" TEXT;
