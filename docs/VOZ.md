# Voz: redução de ruído e eco do microfone

O microfone do PC tem três tratamentos (menu do microfone na barra de baixo → "tratamento da voz"):

| Modo | O que faz | Custo |
| --- | --- | --- |
| **Redução de ruído por IA** (padrão) | RNNoise num AudioWorklet, banda cheia 48 kHz. Cancelamento de eco e ganho automático continuam os do Chrome; o filtro de ruído do Chrome fica desligado (dois filtros empilhados pioram a voz). | ~2% de um núcleo (medido offline no sandbox), ~10–20 ms de atraso, 150 KB baixados uma vez |
| **Filtro do navegador** | O WebRTC do Chrome: eco + ruído clássico + ganho. | O mais leve |
| **Sem tratamento** | Nada de eco, ruído ou ganho; 128 kbps e sem DTX. Para instrumento ou microfone bom com fone. | Nenhum |

Opus da voz: 64 kbps mono com RED (cada pacote vai de novo junto do próximo, perda vira nada) e DTX.
Antes ia com o padrão do LiveKit (48 kbps). Trocar de modo com o microfone ligado republica na hora.

"Ouvir meu microfone" toca o som que está indo para a sala, já tratado, para comparar os modos (use fone).

Código: `web/src/app/core/voice.ts` (modos e processador), `RoomSession.publishMic/setVoiceMode/monitorMic`.
Os arquivos do RNNoise saem de `@sapphi-red/web-noise-suppressor` (MIT) para `/voz/` no build (angular.json).
Se não carregarem, o microfone sobe com o filtro do navegador e aparece um aviso.

## Medições (Chromium headless, 2026-11-11)

- Ruído branco sozinho: -35 dB → -76 dB com a IA (o RNNoise leva ~2 s para aprender o ruído).
- Voz real com ruído na mesma altura (amostra do DeepFilterNet, SNR 0 dB): volume geral -23,9 → -25,0 dB,
  piso de ruído -34,8 dB → silêncio. Antes/depois em `noveau-voz/` nos arquivos do projeto.
- 10,6 s de áudio processados em ~220 ms offline: ~2% de um núcleo.

## O que a pesquisa achou

- **RNNoise** (xiph, BSD): ~0,7% de um núcleo num M4, 150 KB, ~20 ms. Melhor que o filtro do Chrome
  (resíduo -68 dB contra -51 dB numa medição do friendspeak #77). Bom para ruído constante; teclado e
  mastigação passam um pouco.
- **DeepFilterNet 3** (MIT/Apache): o melhor gratuito para ruído de impulso (teclado, mastigar), ~40 ms de
  atraso, ~2,8% de um núcleo, mas ~22 MB de modelo. Os pacotes npm prontos baixam wasm de CDN de terceiro
  sem fonte; o friendspeak compilou o libDF de um commit fixo com tract 0.23 (3x menos CPU que o 0.21) e
  limiares do `deep-filter` (os padrões do binding wasm baixavam a voz 5 dB). Próximo passo candidato:
  modo "IA forte" com esse build.
- **GTCRN** (vem no mesmo pacote): modelo minúsculo, mas trabalha a 16 kHz (a voz perde o que passa de
  8 kHz). Fora por causa da qualidade.
- **Krisp** do LiveKit (`@livekit/krisp-noise-filter`): só no LiveKit Cloud; não serve no chie.
- **voiceIsolation** (constraint do getUserMedia): no Chrome do Windows/macOS/Linux só funciona com a
  flag `WebRtcVoiceIsolationDenoiser` ligada; sem ela o pedido é ignorado em silêncio. Fica pedido só no
  modo do navegador.
- **Eco**: o cancelador do Chrome (AEC3) usa como referência o som que o próprio Chrome toca (inclusive a
  mixagem por Web Audio do LiveKit), mas não o de outros programas (Discord, Spotify) na caixa de som.
  Quem usa caixa e outro app tocando junto vai ter eco: fone resolve. O cancelamento "do sistema" do
  Windows foi testado pelo Chrome e não recomendado.

## Próximos passos possíveis

1. Modo "IA forte" com DeepFilterNet 3 (build próprio do wasm, carregado só quando escolhido).
2. Mesma redução por IA no celular usado como microfone.
3. Tecla de apertar para falar e um portão de ruído ajustável depois da IA.
