# Arquitetura e operação

## Dono dos dados

Um projeto é o diretório mais próximo que contém `.nexo/project.json`. A inicialização explícita usa a raiz Git atual; fora de Git, usa o diretório atual. A busca escolhe o manifesto mais próximo, permitindo projetos aninhados já inicializados. Para criar um board independente dentro de um monorepo, use o MCP init com directoryMode=directory ou o CLI init --here no pacote desejado.

O plugin instalado não contém dados de projeto. Seu runtime empacotado pode ser atualizado sem mover o banco. `.nexo/local/` é estado da máquina e nunca deve entrar no Git. Clones e worktrees não herdam agentes ativos. A configuração `project.json` tem schema versionado e limites por projeto; alterações são revisadas no Git e carregadas na próxima inicialização do serviço.

## Caminho de uma alteração

1. MCP encaminha um comando ao serviço único do diretório, autenticado por bearer token local.
2. O serviço valida schema, versão esperada, histórico sem conflitos, hierarquia, dependências, conclusão, evidência e lease.
3. Uma transação SQLite grava o novo estado e o evento em uma outbox. Constraints e `BEGIN IMMEDIATE` serializam claims.
4. O evento é exportado para um arquivo novo com escrita temporária, fsync e rename. O comando só retorna depois da exportação; uma queda antes dela é recuperada pela outbox no reinício.
5. O serviço notifica os clientes por SSE. O browser busca o snapshot atual completo; a reconexão faz o mesmo, inclusive após reinício da instância.
6. Uma fila por diretório reconstrói o SQLite de distribuição em arquivo separado, fecha e valida o arquivo e o renomeia sobre `project.sqlite`. Alterações duráveis usam debounce de 500 ms, com espera máxima de 5 s para iniciar uma tentativa; heartbeat/release não geram snapshots. O comando `snapshot` aguarda publicação até a geração visível em sua chamada. Bloqueios de substituição têm retry assíncrono limitado e retomada automática; não tornam o banco ativo insalubre. Consulte [os detalhes operacionais](CONCURRENCY.md).

As tabelas de runtime não são copiadas para o snapshot. O schema do snapshot inclui tabelas vazias de agentes para permitir inspeção consistente, mas não inclui tokens, claims ou PIDs. O live SQLite em `local/` usa WAL e synchronous FULL. Nenhum arquivo WAL é commitado.

## Git, causalidade e recuperação

Cada evento tem UUID, projeto, schema, comando idempotente, pais causais e SHA-256 do envelope. O hash detecta alterações acidentais; não é assinatura criptográfica de autoria. Os pais formam um DAG; reprodução topológica com desempate por UUID é determinística. Atualizações concorrentes da mesma versão geram conflito explícito. O perdedor não é aplicado silenciosamente.

Após um merge, mantenha a união dos eventos de ambas as branches. Eventos pais ausentes bloqueiam importação. Nunca remova um evento isolado com descendentes. Um checkout para uma branch anterior deve remover toda a cauda causal que não pertence àquela branch. O serviço refaz a projeção a partir dos arquivos presentes e invalida leases, porque a base de trabalho pode ter mudado.

Procedimento de recuperação:

1. Preserve uma cópia de `.nexo/`; resolva arquivos JSON conflitantes/ausentes no Git.
2. Execute `/nexo:doctor` ou `node <plugin>/runtime/cli.mjs doctor --project <raiz>`.
3. Se houver conflitos semânticos de versão, revise os eventos e o estado resultante. `resolve <event-id>` reconhece explicitamente o perdedor em `resolutions.json`.
4. Reaplique a intenção desejada como um novo comando usando a versão atual. Reconhecer um perdedor não aplica seu conteúdo.
5. Execute `snapshot`; adicione os eventos, resoluções e SQLite reconstruído ao commit.

Se apenas o snapshot binário está em conflito, ele pode ser substituído pelo snapshot reconstruído. Não apague `events/` nem `.nexo/local/` durante uma sessão ativa. Sem a outbox local, trabalho ainda não confirmado pode não ter sido exportado.

## Serviço e worktrees

O processo liga apenas em `127.0.0.1` numa porta disponível. O registro contém PID, instância aleatória, diretório e token. O cliente verifica a identidade por healthcheck; a criação usa mutex de startup e processo detached com janela oculta no Windows. Cada Store mantém um segundo mutex de escritor por toda a vida, inclusive em um `serve` iniciado diretamente. Os mutexes usam locks de SQLite em arquivos permanentes ignorados pelo Git; a morte do processo libera o lock e nenhum timeout toma o lugar de um dono vivo. Não remova esses arquivos. Durante upgrades, o cliente faz shutdown autenticado do daemon daquele diretório, sem downgrade ou encerramento por PID. Ele permanece disponível após a sessão Claude para manter o board aberto.

Por padrão, cada checkout tem seu serviço e visão de branch. Isso evita misturar planos de branches diferentes. Para times de uma mesma entrega trabalharem em outros worktrees com **um único board coordenador**, configure `NEXO_PROJECT_ROOT=<checkout-coordenador>` e `NEXO_WORKSPACE=<worktree-do-time>` no processo Claude. O helper `run` faz isso. A raiz coordenadora recebe os eventos; o time escreve no worktree. A integração dos commits continua sendo uma etapa explícita.

Nunca use o diretório interno `~/.claude/teams` como banco do Nexo. Sessões e agentes Claude fornecem identidade/contexto; MCP e leases fornecem o estado de coordenação do board. Um stop encerra vínculo, mas não prova implementação concluída.

## Limites desta release

SQLite é single-writer, com consultas locais e busca FTS5. Os arquivos JSON e o replay completo priorizam auditabilidade e recuperação. O board busca um snapshot completo e pagina a renderização; não há virtualização completa nem servidor distribuído. Para dezenas de milhares de eventos, meça latência/replay e tamanho dos snapshots antes de adoção. Não foi definido um SLO validado em benchmark para grandes projetos.

Não há replicação multiusuário em rede, autenticação de equipe, busca vetorial, sincronização remota, migrador entre majors de schema, controle de orçamento de toda a conta Anthropic nem sandbox de filesystem. Versões de schema desconhecidas são recusadas em vez de migradas de forma destrutiva. Esses recursos devem ser desenvolvidos e validados conforme a necessidade concreta.
