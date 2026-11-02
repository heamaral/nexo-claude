# Evidência de validação

Execução local em 2026-11-02, Windows, Node 24.22.1 e Claude Code 2.1.316. Estes resultados descrevem o ambiente testado; não são uma garantia de desempenho para qualquer máquina ou volume.

## Testes reais do Claude

O script opt-in `scripts/acceptance.mjs` carregou o plugin com `--plugin-dir` em um repositório temporário autenticado:

- Planner nativo criou entrega, workflow, time, cards e dependência via MCP.
- Planner registrou sua própria claim; uma atualização desatualizada foi recusada e recuperada com nova leitura.
- Agent nativo `nexo:worker` recebeu sua identidade pelo hook, assumiu o card e registrou resultado/evidência.
- Ambos os cards terminaram concluídos; a entrega foi aceita e não restaram agentes ativos.
- Subagente compartilhou sessionId do pai e usou agentId próprio, conforme o modelo nativo do Claude.

O script `scripts/acceptance-parallel.mjs` iniciou dois helpers `run` em worktrees Git diferentes, apontando ao mesmo coordenador:

- Dois agentes ativos simultâneos foram observados no mesmo projeto.
- As sessões leram os dois times, concluíram seus próprios cards com as leases já adquiridas e liberaram os vínculos.
- Ambos os processos encerraram com código zero e nenhum agente ativo remanescente.

São ensaios do protocolo/lifecycle em fixtures, sem implementação de uma feature de produto e sem aprovação automática de shell. Não substituem um piloto completo de edição, integração e revisão em um projeto real.

## Verificação automatizada

Os testes Node cobrem controle de versão, idempotência, hierarquia/ciclos, claims simultâneas, sobreposição de escrita, expiração/fencing, evidências, histórico aceito, snapshot, replay, conflito de branches, isolamento de projetos, descoberta de projeto aninhado, HTTP e protocolo MCP oficial. Um teste separado de navegador verifica dados reais, SSE, temas, modais, fluxo, animação, movimento reduzido e viewports 1440/1024/768/390/320.

Validação oficial de plugin e marketplace passou em modo estrito; o perfil de diretório também passou. Auditoria de dependências de produção retornou zero vulnerabilidades conhecidas nessa execução.

## Medição local inicial

Fixture: 1.000 cards em cadeia de dependências, 1.001 eventos, uma entrega, sem agentes executando; gravações duráveis individuais em SSD local.

| Operação                                          | Tempo observado |
| ------------------------------------------------- | --------------: |
| Criar 1.000 cards e eventos                       |          6,47 s |
| Gerar snapshot SQLite fechado                     |          112 ms |
| Consultar estado completo                         |         2,59 ms |
| Buscar com FTS5                                   |         2,16 ms |
| Reconstruir após remover somente a projeção local |          480 ms |
| Snapshot resultante                               |         1,27 MB |

O ledger usa cache de metadados, fronteira causal persistida e consultas indexadas para evitar releitura de todos os arquivos em cada comando. O replay e snapshots ainda percorrem o histórico completo. Um SLO para dezenas de milhares de cards e múltiplos usuários permanece fora desta evidência.
