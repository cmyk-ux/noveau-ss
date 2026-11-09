# Clipes no Cloudflare R2

O botão de clipe guarda os últimos 2 min da tela em foco. Ao clipar, o navegador manda o MP4
**direto para o R2** (o servidor só assina o endereço, então os ~150 MB não passam pela RAM dele),
e quem clipou recebe um link de download que vale 5 min. Depois disso o arquivo é apagado.

## 1. Criar o bucket

1. No painel da Cloudflare: **R2 Object Storage** > **Create bucket**.
2. Nome: `noveau-clipes` (qualquer um serve). Location: Automatic. Storage class: Standard.

## 2. Liberar o site para mandar arquivos (CORS)

No bucket: **Settings** > **CORS Policy** > **Add CORS policy**, aba JSON, cole:

```json
[
  {
    "AllowedOrigins": ["https://noveau.riajuu.net", "http://localhost:4200"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type"],
    "MaxAgeSeconds": 3600
  }
]
```

Sem isso o clipe falha com "O envio para o R2 foi barrado (confira o CORS do bucket)".
A regra leva até 30 s para valer.

## 3. Criar a chave

1. Na página do **R2 Object Storage** > **Manage API tokens** (ou "API Tokens" no canto) > **Create Account API token**.
2. Permissão: **Object Read & Write**. Em "Specify bucket(s)", escolha só o `noveau-clipes`.
3. Crie. A Cloudflare mostra **uma vez só** o *Access Key ID* e o *Secret Access Key*. Copie os dois.
4. O *Account ID* aparece na página inicial do R2 (lado direito) e no endereço do painel.

## 4. Colocar no servidor (chie)

Os valores ficam só no servidor, nunca no git. No chie:

```sh
sudo sh -c 'cat >> /etc/noveau-ss/env' <<'FIM'
R2_ACCOUNT_ID=cole-aqui
R2_ACCESS_KEY_ID=cole-aqui
R2_SECRET_ACCESS_KEY=cole-aqui
R2_BUCKET=noveau-clipes
FIM
sudo herd restart noveau-ss
sudo tail -n 20 /var/log/noveau-ss
```

O log deve mostrar `Clipes: ligados (Cloudflare R2)`. Para rodar no PC, as mesmas linhas vão no `.env`.

## Custo

R2 cobra armazenamento por GB-mês e não cobra download. Clipes vivem 5 min, então o armazenamento
fica perto de zero; as operações (upload, consulta, apagar) ficam muito abaixo da cota grátis.
