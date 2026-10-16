// A stand-in Worker for the deploy tests: the real bundle changes with every build, these bytes do not.
export default { fetch: () => new Response("furea test instance") };
