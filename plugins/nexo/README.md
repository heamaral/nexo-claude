# Nexo

Planejamento por entrega, cards hierárquicos, dependências, times e agentes em um board local para Claude Code. Cada projeto guarda histórico em `.nexo/`: eventos JSON versionáveis e um snapshot SQLite. Agentes ativos e credenciais locais são ignorados pelo Git.

Requer Node.js 24.22.x e Claude Code 2.1.316 ou posterior. Execute `/nexo:init` no projeto e use `/board` ou `/nexo:board`. Use `/nexo:plan` para planejar e coordenar uma entrega; `/nexo:status` consulta progresso. O runtime e a interface já estão empacotados: não há instalação de dependências no início da sessão.

Versão 1.0.0-rc.1: o lifecycle com sessões autenticadas foi validado; um piloto completo de implementação e a matriz multiplataforma continuam sendo gates da versão estável. Leia o README e os documentos de operação no repositório antes de adotar em projetos importantes.

Instalação direta no Claude Code: `/plugin install nexo --marketplace heamaral/nexo-claude`.
