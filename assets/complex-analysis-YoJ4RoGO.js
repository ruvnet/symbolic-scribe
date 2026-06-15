const n=`---\r
title: Complex Analysis Foundations\r
domain: mathematics\r
category: Complex Analysis\r
overview: Advanced study of complex functions, including integration, series expansions, and residue theory.\r
---\r
\r
# Complex Integration\r
∮ f(z)dz = 2πi∑Res(f,ak)\r
\r
# Series Expansions\r
Let f(z) = ∑(n=0 to ∞) an(z-z₀)ⁿ\r
\r
# Residue Theory\r
Res(f,a) = 1/(2πi)∮ f(z)dz\r
\r
# Conformal Mappings\r
w = f(z) preserves angles\r
∂u/∂x = ∂v/∂y\r
∂u/∂y = -∂v/∂x`;export{n as default};
