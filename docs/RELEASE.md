# Gates de lançamento

## 1.0.0-rc.2

Caminho agora usa um grafo interativo com ramificações, junções, modos de dependências e hierarquia, contexto externo, zoom/pan e tela cheia. O upgrade substitui um servidor antigo de forma graciosa, preservando cards e leases. Consulte [o guia do grafo](GRAPH.md). Nenhuma migração do banco é necessária.

## 1.0.0-rc.1

Implementado: plugin Claude Code com marketplace privado, MCP stdio empacotado, planner/worker/reviewer, skills, hooks, estado por diretório, SQLite/ledger, leases com fencing, workflow por entrega, evidências, prevenção de ciclos, histórico aceito imutável, FTS5, serviço loopback autenticado, SSE, board real claro/escuro e modais.

Os testes exercitam oito solicitações de claim simultâneas, perda de lease, concorrência por escopo, versão/idempotência, ciclos combinados, evidência, histórico, replay após checkout, conflito entre branches, snapshot sem runtime, HTTP host/origin/auth/body, SSE, protocolo MCP oficial e o navegador real em vários tamanhos e movimento reduzido. Consulte a execução do CI para o resultado do commit exato.

Antes da promoção para 1.0.0 estável:

- [x] CI Windows/Linux/macOS e Chromium Linux no commit 0346bd4; correções de caminhos e layout confirmadas.
- [x] Marketplace privado e instalação por projeto validados em perfil Claude isolado, incluindo node_path configurado.
- [ ] Piloto interativo no menu `/board` na instalação principal do usuário.
- [x] Planner/worker nativos criaram e concluíram uma entrega de teste, com entrada/saída observada.
- [ ] Piloto de feature real com edição, integração e reviewer no mesmo commit.
- [x] Duas sessões simultâneas em worktrees distintos, apontando ao mesmo coordenador.
- [x] Helper `run` validado com autenticação existente, permissões normais e orçamento explícito.
- [ ] Encerrar forçadamente uma sessão, retomar e testar recuperação sem duplicar conclusão.
- [ ] Executar merge real com alteração concorrente e revisar resolução.
- [ ] Definir e medir escala/SLO para os maiores projetos que serão usados.
- [ ] Revisão de segurança e recuperação em máquina limpa.

Esses gates são critérios de qualidade da entrega, não exigências de confirmação para tarefas reversíveis. Não anuncie a versão como produção validada enquanto eles estiverem pendentes.
