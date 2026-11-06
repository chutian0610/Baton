# One hierarchy: single-parent task tree, DAG dependencies, flat projects

Decomposition lives in exactly one place: the parent/child task tree, strictly single-parent. Ordering lives in the dependency DAG, orthogonal to the tree. Projects are flat — no nesting, no dotted hierarchies (à la Taskwarrior's `project:home.kitchen`), and no milestone entities (a milestone is just a parent task). Cross-cutting grouping is what Tags are for.

If a modeling need feels like it wants project nesting or multi-parent tasks, the answer is to remodel the task tree or use dependencies — never to add a second hierarchy. Two places to express "belongs under" would drift apart.
