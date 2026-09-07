---
"legend-doctor": patch
---

Stop effects from waiting on a state that can never change. A `useState` with no setter binding is a
component-lifetime constant, so it is no longer treated as a reactive dependency; effects that read one now name
the state whose ownership is actually open.

Report `const [, setTick] = useState(0)` as the forced render it is, naming the setter, instead of calling the
binding a non-standard `[value, setter]` tuple.

Correct the `--materiality` help text and README: the 12-element bar applies to cuts proven by owner size, and
cuts proven by a transported read or a hook owner do not use it.
