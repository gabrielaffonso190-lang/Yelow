# VANTA

Bot modular para Discord, em Node.js 22.9+ com discord.js v14 e ES Modules.

## Funcionalidades

- `/ping`, `/healty`, `/config center`, `/comprar`, `/carrinho`,
  `/personalizar`, `/conversa limpar` e `/missoes`.
- Configuração por servidor, catálogo editável, estoque, carrinhos, cupons,
  pedidos e tickets privados persistidos no SQLite existente.
- Painel MATRIX persistente no canal configurado (por padrão,
  `1560463567025606677`), com indicadores operacionais e recuperação após
  reinicialização. O painel atualiza a mensagem registrada em vez de publicar
  uma nova a cada inicialização.
- `/anuncio preparar` para criar prévias, anexar imagens do Discord, limitar
  menções a um cargo escolhido, adicionar um botão HTTPS e reutilizar até dez
  modelos administrativos.
- Identidade visual VANTA, assinatura `Vanta - 2027` e artes quadradas
  individuais para os 26 produtos padrão. Detalhes de produto anexarão a arte
  correspondente quando disponível; imagens próprias enviadas pela equipe têm
  precedência.
- IA por menção, com histórico limitado, ferramentas explícitas e propostas de
  alteração sujeitas à aprovação da equipe. A aplicação consulta os modelos
  disponíveis na conta NVIDIA e usa GLM 5.3 Flash somente se estiver listado.
- Sessões privadas de personalização com prazo de 15 minutos e armazenamento
  local privado de imagens enviadas no Discord.
- Comandos por prefixo `!vanta` e `!yelow` (mantém `!vinter` como alias) e
  menção ao bot para perguntas à IA ou execução dos comandos compatíveis.
- VANTA MISSIONS com cadastro e verificação manual, anúncios, prazo, alertas
  automáticos e histórico de auditoria. Não consulta nem automatiza Quests.

Pix pelas APIs documentadas da Z.PAY e da VoxPay está integrado ao fluxo
existente de pedidos. Z.PAY é o provedor principal por padrão e VoxPay é o
alternativo; custos de fornecedor não encontrados permanecem pendentes, e
Robux/GamePass são encaminhados à equipe para confirmação.

## Requisitos

- Node.js 22.9 ou superior (`node:sqlite` e carregamento opcional de `.env`).
- Aplicação/bot configurados no
  [Discord Developer Portal](https://discord.com/developers/applications).
- `DISCORD_TOKEN` e o intent **Message Content Intent** habilitado para a IA por
  menção e o prefixo.
- SQLite em `data/vintermod.sqlite`; um banco vazio recebe o schema base, e os
  bancos existentes recebem somente migrações aditivas. O caminho pode ser
  substituído com `DATABASE_PATH`.
- `NVIDIA_API_KEY` para conversar com o provedor de IA.
- `ZPAY_CLIENT_ID` e `ZPAY_CLIENT_SECRET` para criar cobranças Pix.
- `ZPAY_ENVIRONMENT` pode ser `production` (padrão) ou `sandbox`.
- `VOXPAY_API_KEY` para habilitar VoxPay como provedor alternativo.

## Configuração

Copie `.env.example` para `.env`, configure os valores localmente ou use os
Codespaces Secrets. Não faça commit de `.env`, tokens, imagens ou do banco de
dados. O bot não imprime valores secretos.

```sh
cp .env.example .env
npm install
```

Configure `DISCORD_CLIENT_ID` para registrar comandos. `DISCORD_GUILD_ID` é
opcional e limita o registro ao servidor de desenvolvimento.
`MATRIX_CHANNEL_ID` pode substituir o canal padrão do painel MATRIX. Convide o
bot com os escopos `bot` e `applications.commands`, além das permissões
necessárias para criar canais privados, gerenciar canais e enviar mensagens.
Habilite **Message Content Intent** para a IA por menção e comandos por prefixo.
Configure permissões de DM para receber respostas privadas aos comandos de
prefixo.

## Execução

```sh
npm test
npm run deploy:commands
npm start
```

`npm run deploy:commands` publica a lista atualizada de slash commands para o
Discord; execute após a primeira instalação ou quando os comandos mudarem.
`/config center` já é um comando slash com subcomando `center`. `npm run dev`
inicia o modo watch.

Comandos de prefixo suportados: `!vanta ajuda`, `!vanta ping`, `!vanta healty`,
`!vanta conversa limpar`, `!vanta missoes listar`, `!vanta comprar`,
`!vanta personalizar` e `/anuncio` como `!vanta anuncio preparar`.
`!yelow` é um alias. Os comandos `/config center` e `/carrinho` continuam
exclusivamente slash para manter seus painéis privados/interativos. As respostas
privadas por prefixo são enviadas por DM; `!vanta comprar` e a prévia de anúncio
permanecem no canal para que seus botões funcionem. Também é possível mencionar
o bot, por exemplo `@VANTA ping` ou `@VANTA missoes listar`; uma menção seguida
de texto livre continua sendo uma conversa com a IA.

Para cadastrar uma Quest por prefixo, use argumentos `chave="valor"`:

```text
!vanta missoes cadastrar nome="Quest oficial" conteudo="Jogo" tipo=play requisitos="Jogar 15 minutos" recompensa="Item oficial" encerramento="2026-12-31T23:59-03:00" plataformas="Windows, macOS" fonte="https://discord.com/blog/fonte" como_encontrar="Abra Discord > Quests"
```

No primeiro `/comprar` ou `/config center`, o catálogo inicial é inserido
somente para produtos que ainda não existem no servidor. Os estoques definidos
no prompt são usados para os sete itens com quantidades conhecidas; os demais
começam em 5, sem serem redefinidos em reinicializações. Custos não fornecidos
não são inventados. A equipe deve configurar o custo do fornecedor no Config
Center; o preço de venda é calculado como custo × 1,30.

## Config Center e segurança

Use `/config center` como proprietário, administrador do servidor ou portador
dos cargos Poder geral/Founder configurados no código. Gestão e Direção podem
consultar as seções operacionais do MATRIX e atender tickets, mas não alterar a
configuração administrativa. As ações interativas também validam permissão no
servidor.

O comando `/healty` exibe latência, uptime, memória, CPU e estado do SQLite e
das integrações sem revelar credenciais. A seção MATRIX de Missões mostra
contagens atuais. Relatórios financeiros, histórico `/minhas-compras` e
feedback ainda não estão implementados. O gerenciador de anúncios está
disponível por `/anuncio preparar`.

## VANTA MISSIONS

Use `/missoes cadastrar`, `/missoes atualizar`, `/missoes listar`,
`/missoes encerrar`, `/missoes anunciar` e `/missoes alertas`. Somente
administradores autorizados podem gerenciar dados e publicar. Cada cadastro
exige uma fonte HTTPS oficial e um link oficial da Quest ou instruções para
encontrá-la; a equipe é responsável por verificar a fonte e confirmar a
recompensa. O sistema registra quem verificou e quando.

Configure o canal de encerramento com `/missoes alertas canal:#canal`. O bot
avisa uma vez quando uma Quest ativa entra nas 24 horas finais, encerra Quests
expiradas e impede que elas sejam anunciadas. Atualizar a Quest registra nova
verificação e permite atualizar seu anúncio existente.

Os anúncios incluem imagem/banner, requisitos, recompensa informada, prazo,
plataformas, fonte e botão “Ver Quest no Discord”. Se não houver um link direto,
o botão mostra as instruções registradas. O cadastro é exclusivamente manual:
não há integração de consulta oficial presumida, leitura não autorizada,
aceitação automática, gameplay ou progresso simulado.

O MATRIX mostra contagens diretamente das tabelas atuais. O schema de pedidos
rastreia tentativas de cobrança em uma tabela aditiva `payments`; o estado do
pedido existente não foi alterado. Não existe comando de limpeza em massa no
projeto.

Z.PAY usa o SDK oficial documentado `@isnouu/zpay-sdk` (Node.js 18+); VoxPay
usa `POST /api/v1/charges` e `GET /api/v1/charges/{id}` documentados em
[voxpaybr.com/documentacao](https://voxpaybr.com/documentacao). Valores de
entrada são reais; os snapshots financeiros são centavos. Z.PAY limita Pix
entre R$ 2,00 e R$ 2.000,00, e VoxPay aplica os limites da própria API. Os
provedores usam, respectivamente, `idempotencyKey` e `external_reference`
estáveis por pedido. O QR, copia e cola, valor e status são exibidos no ticket.
HTTP 401/403 e erros VoxPay documentados de autenticação/configuração são
recusas definitivas e ativam o próximo provedor configurado. Timeout, 429 e
erros com resultado incerto nunca iniciam failover ou uma segunda cobrança.

Para webhooks, configure `ZPAY_WEBHOOK_SECRET` e/ou `VOXPAY_WEBHOOK_SECRET` e
aponte o dashboard para `https://seu-dominio/webhooks/zpay` ou
`https://seu-dominio/webhooks/voxpay`, encaminhando ao
`ZPAY_WEBHOOK_PORT` (padrão 8787). O servidor valida assinatura HMAC, timestamp,
valor do pedido e idempotência; eventos Z.PAY Sandbox são recusados. A
documentação VoxPay informa que o envio externo está pausado; para essa
integração, a confirmação normal usa consulta autenticada ao status. Ambos os
endpoints precisam ser publicados via HTTPS.

`PAYMENT_PROVIDER` seleciona a ordem de tentativa (`zpay` por padrão,
`voxpay` para priorizar VoxPay). Nenhuma cobrança real foi criada durante os
testes.

O Sandbox Z.PAY é opt-in por `ZPAY_ENVIRONMENT=sandbox`, usa a base
`/api/v1/sandbox`, fica isolado das cobranças de produção e não tenta VoxPay
como fallback. A arte do pedido é marcada como teste; simulações são limitadas
ao adaptador de teste e nunca marcam pagamentos de produção. Webhooks Sandbox
são recusados no endpoint de produção.

Anúncios são preparados e confirmados por administradores. Uma publicação tem
registro idempotente: se o resultado de uma tentativa ficar incerto, o bot
bloqueia uma segunda publicação do mesmo rascunho e pede verificação manual no
canal antes de preparar outro.

O provedor de IA usa o endpoint OpenAI-compatible da NVIDIA. Antes da chamada,
consulta `/v1/models`; prefere `z-ai/glm-5.3` e recorre a
`z-ai/glm-5.3-flash` somente quando a conta lista esse modelo. Erros HTTP,
limites e timeouts são tratados sem registrar a chave.

As artes do catálogo podem ser regeneradas com `npm run build:product-art`.
Elas são composições gráficas próprias, sem logotipos oficiais de terceiros.
Emojis da aplicação são opcionais: configure os nomes reais usando
`VANTA_EMOJI_*` depois que o bot puder consultar a aplicação. O código não
presume IDs, e os componentes não recebem emoji quando um nome configurado não
existe.

Uploads são aceitos apenas dentro de sessões de personalização. O conteúdo é
validado por assinatura binária, limitado a 8 MB e armazenado em
`data/private-images` com permissões privadas. Imagens só são anexadas a painéis
quando um membro autorizado as seleciona e publica.

## Limitações externas

- Para a chave testada nesta auditoria, o catálogo NVIDIA listou
  `z-ai/glm-5.3-flash`, mas não `z-ai/glm-5.3`; a IA escolhe o Flash. A
  consulta de modelos não substitui um teste de geração de chat.
- As credenciais Z.PAY/VoxPay ainda precisam ser configuradas e não houve
  validação com uma cobrança real. A tentativa de consulta VoxPay anterior
  retornou `401 invalid_api_key`, portanto confira/revogue a chave no painel.
- O bot não automatiza a entrega dos produtos. Confirmação de pagamento fica
  registrada, mas a equipe continua responsável pelo atendimento/entrega.
- O bot não expõe comandos Discord para simular pagamentos Sandbox; a API de
  simulação fica disponível apenas no adaptador Z.PAY em modo Sandbox.
- `npm start` usa o `DISCORD_TOKEN` do `.env` local quando o arquivo existe;
  sem `.env`, usa o Secret de ambiente. O `.env` é excluído do pacote Discloud.
- É preciso configurar custos reais dos produtos antes de disponibilizá-los
  para compra. Robux e GamePass aguardam confirmação manual de preço.
- A configuração da IA não comprova disponibilidade da chave, do endpoint ou
  do modelo na conta; valide no ambiente antes de anunciar a função como ativa.
- O SQLite local exige armazenamento persistente no ambiente de execução. Os
  uploads também dependem da persistência de `data/private-images`.

## Deploy na Discloud

O repositório inclui `discloud.config` (bot Node.js LTS, entrada
`src/start.js`, `npm start`, 512 MB) e `.discloudignore`, que exclui segredos,
dependências locais e testes sem descartar `data/`. Configure os Secrets no
painel da Discloud antes de iniciar. Faça backup do SQLite e de
`data/private-images` e use armazenamento persistente da plataforma: os arquivos
locais são essenciais para preservar pedidos, configurações e imagens. O schema
é inicializado somente quando o banco está vazio; um banco existente não é
recriado nem limpo.
