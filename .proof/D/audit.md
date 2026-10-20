# Attention

reviewed by claude-opus-5-5

Reviewer: Apiary session edee73fc-5d3d-4654-9046-c18550bc58cc (fresh isolated Cell, read-only review).

The first audit identified the lost late-record risk in a pre-stop copy. The final implementation links the validated rollout inode, checks source and temporary regular-file identity, recognizes an already-shared inode, and quarantines failed temporary links outside sessions/. The late-SIGTERM, symlink, repeated-swap and rename-collision lab cases passed. The final audit closed with no open flags (Apiary message 7187).

Review limits: the reviewer inspected final helper source and earlier daemon diff inline, read the author's Apiary transcript, and did not run tests. Early reviewer read-only shell calls lacked env -i/fake HOME; the deviation was reported, and all further review used the inline packet and native Apiary tools. No credential values were read or exposed.

Stated implementation limits remain in README.md: same-filesystem hardlinks required; native symlink rollouts refused; real Codex provider validation deferred to the Project lab; corrupt carried rollout refuses rather than starting empty; carried account-home files remain after deletion. The human's instruction forbids new unit tests; lab.ts is committed integration proof. No deployment or merge is authorized.
