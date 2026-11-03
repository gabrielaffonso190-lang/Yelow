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
  alteração sujeitas à aprovação da equipe. Usa NVIDIA GPT-OSS e, se esse
  provedor falhar, o fallback GPT-5 mini do Huehue.
- Sessões privadas de personalização com prazo de 15 minutos e armazenamento
  local privado de imagens enviadas no Discord.
- Comandos por prefixo `!vanta` e `!yelow` (mantém `!vinter` como alias) e
  menção ao bot para perguntas à IA ou execução dos comandos compatíveis.
- VANTA MISSIONS com descoberta de artigos no RSS oficial do Discord Blog,
  revisão manual de candidatas, cards VANTA, publicação opcional, prazo,
  alertas e métricas MATRIX. Discord Discover e Newsroom continuam manuais.

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
- `NVIDIA_API_KEY` para a IA principal. `HUEHUE_API_KEY` habilita o fallback
  GPT-5 mini pelo endpoint oficial informado do Huehue.
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
Configure `HUEHUE_API_KEY` nos Secrets para o fallback da IA; nunca coloque a
chave no código ou em mensagens. Um HTTP 401 do Huehue significa que a chave ou
o acesso à API precisa ser corrigido no painel do provedor.
`.env.example` inclui IDs das application emojis VANTA. São IDs públicos dos
emojis da aplicação, não chaves; os 29 IDs foram confirmados com o Discord.
O bot usa esses IDs por padrão, aceita substituições por ID ou nome e não exige
copiá-los para `.env`.

## Diagnóstico de inicialização na Discloud

Use Node.js 22.9 ou superior, conforme `engines` no `package.json`; o bot usa
`node:sqlite`. Falhas ao carregar a configuração, importar módulos ou conectar
ao Discord registram nome, mensagem e stack trace. Valores de variáveis de
ambiente com nomes de token, chave, segredo ou senha são redigidos do log.
Se aparecer `Missing required environment variable: DISCORD_TOKEN`, configure
esse Secret no painel da Discloud e reinicie o bot, sem colar o valor nos logs.
Se o processo for encerrado sem uma falha JavaScript registrada, consulte o
histórico de memória/encerramento da plataforma: um limite de RAM pode encerrar
o processo antes que o Node consiga registrar um stack trace.

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
`!vanta conversa limpar`, `!vanta missoes listar`, `!vanta missoes fontes`,
`!vanta missoes descobrir`, `!vanta missoes teste`, `!vanta comprar`,
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
`/missoes encerrar`, `/missoes anunciar`, `/missoes alertas`,
`/missoes fontes` e `/missoes descobrir`. Somente administradores autorizados
podem gerenciar dados e publicar. Cada cadastro exige uma fonte HTTPS oficial
e um link oficial da Quest ou instruções para encontrá-la; a equipe confirma
requisitos, recompensa, prazo e plataformas, e o bot registra a verificação.

Configure o canal de encerramento com `/missoes alertas canal:#canal`. O bot
avisa uma vez quando uma Quest ativa entra nas 24 horas finais, encerra Quests
expiradas e impede que elas sejam anunciadas. Atualizar a Quest registra nova
verificação e permite atualizar seu anúncio existente.

O Config Center > Missões permite escolher o canal, ativar/desativar publicação
automática, ajustar a consulta (15 a 1.440 minutos), exigir aprovação, limitar
menções a cargos existentes e testar uma prévia privada. A publicação
automática só envia Quests cadastradas e verificadas recentemente; com
aprovação exigida, a equipe publica por `/missoes anunciar`.

O bot consulta `https://discord.com/blog/rss.xml`, feed RSS público oficial,
para encontrar artigos que mencionem Quest. Esses artigos são apenas candidatas:
não garantem que uma promoção esteja ativa nem contêm necessariamente seus
requisitos, recompensas ou validade. Nenhuma candidata é convertida ou
anunciada automaticamente como Quest; a equipe confirma os dados e cadastra.
Discord Discover → Quests não tem API pública documentada de consulta, e o
Discord Newsroom não apresentou um feed estruturado estável; ambos são exibidos
como fontes de conferência manual no Config Center, no MATRIX e em
`/missoes fontes`. A indisponibilidade do RSS é registrada sem parar o bot.

Cards usam banner fornecido pela equipe após validação HTTPS, tipo e tamanho;
a origem e o identificador da imagem ficam registrados. Se não há banner, o
bot gera um PNG próprio em preto, branco e cinza com a identidade VANTA. Os
anúncios mostram requisitos, recompensa, prazo, plataformas, fonte, data da
última verificação e botão “Ver Quest no Discord”. Quests expiradas são
encerradas e o anúncio existente é atualizado; alterações de dados atualizam a
mensagem original. A deduplicação usa identificador persistente e fingerprint
da fonte/conteúdo. Não há uso de endpoints privados, tokens de usuário,
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

O provedor principal usa o endpoint OpenAI-compatible da NVIDIA com
`openai/gpt-oss-20b`; esse modelo aberto não é o produto ChatGPT. Se a NVIDIA
falhar ou não estiver configurada, o bot chama `POST
https://huehue.app/v1/chatgpt` com `HUEHUE_API_KEY` e o campo JSON `mensagem`.
O Huehue informa que usa GPT-5 mini e inicia uma conversa nova por chamada;
por isso, o bot inclui um resumo limitado da conversa no prompt de fallback.
Ferramentas da VANTA (consultas de pedidos, catálogo e propostas de alteração)
continuam disponíveis somente quando a NVIDIA responde. HTTP, autenticação,
limites e timeouts são tratados sem registrar a chave.

As artes do catálogo podem ser regeneradas com `npm run build:product-art`.
Elas são composições gráficas próprias, sem logotipos oficiais de terceiros.
Emojis da aplicação usam os IDs VANTA validados e permitem substituir cada um
com `VANTA_EMOJI_*`. Se um emoji não estiver disponível para a aplicação,
componentes continuam válidos sem esse emoji.

Uploads são aceitos apenas dentro de sessões de personalização. O conteúdo é
validado por assinatura binária, limitado a 8 MB e armazenado em
`data/private-images` com permissões privadas. Imagens só são anexadas a painéis
quando um membro autorizado as seleciona e publica.

## Limitações externas

- A conta NVIDIA lista `openai/gpt-oss-20b`, mas testes recentes de geração
  expiraram; catálogo disponível não comprova que o modelo esteja respondendo.
- A chamada de teste do Huehue retornou HTTP 401 para a credencial atualmente
  configurada. O fallback está implementado, mas exige uma chave Huehue válida
  e acesso autorizado para funcionar.
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
- O health check não consome chamadas de geração; valide a IA mencionando o bot
  depois de configurar chaves válidas para os provedores.
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
