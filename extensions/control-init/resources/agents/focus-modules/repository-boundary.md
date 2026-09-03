### Repository boundary

Implement product behavior only in the repository that owns runtime artifacts. Keep control-plane state and verification outside product and paper repositories. Dependencies are one-way: control may inspect code; code must not inspect control or LaTeX; separate paper repositories must not depend on one another.
