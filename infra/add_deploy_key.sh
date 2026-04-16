#!/bin/bash
# Execute este script na VPS (via console Portainer ou painel do provedor)
# Adiciona a chave pública do GitHub Actions ao authorized_keys

PUBKEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPSIabfdEczLS8TI2oKTs0deuJFaQrqc26g0C3L9ngvv github-actions-deploy@lexcrm"

mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo "$PUBKEY" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
echo "✅ Chave de deploy do GitHub Actions adicionada com sucesso!"
