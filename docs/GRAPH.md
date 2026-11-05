# Delivery graph

The Graph view uses a deterministic left-to-right DAG layout instead of repeating dependencies in separate rows. Branches, joins and a task's position are derived from the stored plan, not the order returned by SQLite. Each card appears once.

- **Dependencies**: solid arrows run from prerequisites to dependent tasks. Dashed arrows show a subtask contributing to a parent, or independent terminal tasks contributing to the delivery result. They do not invent execution dependencies. With one terminal task, that task is the visible endpoint; multiple terminal tasks join a delivery result node.
- **Hierarchy**: the delivery expands into root cards and their children. These relationships describe composition, not execution order.
- External prerequisites are shown as distinct, clickable cards without importing another delivery's entire graph.
- Long connections reserve layout lanes to avoid passing through cards. Cyclic imported data produces a warning and remains inspectable.
- Cards open the existing detail modal. Actual active leases drive the animated working borders; blockers and completed tasks retain their status colors.
- Pan by dragging empty space; zoom with controls or Ctrl/Cmd + wheel. Use Fit, the percentage control for 100% zoom, or fullscreen. Keyboard users can Tab to nodes and open them with Enter; arrows pan the focused canvas, +/- zoom and 0 fits.
- Search highlights matching cards while preserving the surrounding topology. The results button focuses those matches. Status updates preserve the user's camera; new topology can be fitted explicitly.

The graph does not change task data, workflows or dependencies. If a relationship is absent from the planner's data, the UI cannot infer it from card titles. Scale remains bounded by browser rendering resources; this release is not a claim of unlimited graph capacity.

## Updating an already running board

The plugin version, marketplace entry, MCP server and daemon share the same release version. Newer clients gracefully replace older local daemons under the startup lock; SQLite records and active leases are retained. Older clients reuse newer daemons rather than downgrading them. No process is killed by PID. Reopen `/board` after reloading the plugin so browser authentication and the new server URL are refreshed.
