const r=`---\r
title: Category Theory Concepts\r
domain: mathematics\r
category: Category Theory\r
overview: Abstract mathematical framework dealing with mathematical structures and relationships between them.\r
---\r
\r
# Basic Definitions\r
C = (Ob(C), hom(C), ∘)\r
F: C → D (Functor)\r
\r
# Natural Transformations\r
η: F ⇒ G\r
∀X∈Ob(C): ηX: F(X) → G(X)\r
\r
# Universal Properties\r
Initial Object: ∀X∃!f:I→X\r
Terminal Object: ∀X∃!f:X→T\r
\r
# Adjunctions\r
F ⊣ G\r
Hom(F(A),B) ≅ Hom(A,G(B))`;export{r as default};
