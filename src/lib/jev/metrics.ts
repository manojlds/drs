import { metricKeys, type MetricKey } from './types.js';

export { metricKeys };

export interface MetricDefinition {
  key: MetricKey;
  label: string;
  guidance: string;
  suggestion: string;
  conditional: boolean;
  priorityWeight: number;
  weaknesses: Record<string, string>;
}

// Metric dimensions and weakness rubric are adapted from jev-review 0.1.1
// (MIT), commit 57690af54ef7d862c2483342c1e61c14dffcf727.
function metric(
  key: MetricKey,
  label: string,
  guidance: string,
  suggestion: string,
  weaknesses: Record<string, string>,
  options: { conditional?: boolean; priorityWeight?: number } = {}
): MetricDefinition {
  return {
    key,
    label,
    guidance,
    suggestion,
    weaknesses: {
      no_material_issue: 'No material issue is evident from the supplied context.',
      ...weaknesses,
    },
    conditional: options.conditional ?? false,
    priorityWeight: options.priorityWeight ?? 1,
  };
}

export const metricDefinitions: readonly MetricDefinition[] = [
  metric(
    'correctness',
    'Correctness and requirement fit',
    'Judge requested behavior, missing behavior, edge cases, invariants, assumptions, regressions, completeness, and invalid states.',
    'Address the concrete requirement, edge-case, invariant, or regression risk.',
    {
      missing_behavior: 'Requested behavior appears missing or incomplete.',
      edge_case: 'An important edge case or invalid state appears insufficiently handled.',
      incorrect_assumption:
        'The implementation appears to rely on an unsafe or incorrect assumption.',
      regression_risk: 'The change creates a meaningful risk of breaking existing behavior.',
    },
    { priorityWeight: 3 }
  ),
  metric(
    'cognitiveComplexity',
    'Cognitive complexity',
    'Judge nesting, branching, hidden control flow, indirection, side effects, special cases, state management, and cleverness.',
    'Simplify the hardest control or data flow while preserving cohesion.',
    {
      control_flow: 'Control flow is harder to follow than the problem requires.',
      indirection: 'Indirection obscures rather than clarifies the behavior.',
      state_management: 'State transitions or side effects are difficult to reason about.',
      special_cases: 'Special cases add disproportionate mental overhead.',
    },
    { priorityWeight: 2 }
  ),
  metric(
    'readability',
    'Readability and intent',
    'Judge naming, flow clarity, responsibilities, transformations, useful comments, and consistency.',
    'Make intent explicit through clearer naming, flow, or boundaries.',
    {
      naming: 'Names do not communicate intent precisely enough.',
      flow_clarity: 'The control or data flow is not immediately understandable.',
      responsibility_clarity: 'Responsibilities or transformations are difficult to identify.',
      comment_quality:
        'Comments are missing where rationale matters or add noise without rationale.',
    }
  ),
  metric(
    'modularity',
    'Modularity and cohesion',
    'Judge coherent grouping, separation of responsibilities, domain boundaries, and colocation.',
    'Regroup responsibilities around cohesive domain behavior.',
    {
      mixed_responsibilities:
        'Unrelated responsibilities are coupled in the same module or boundary.',
      fragmentation: 'Related behavior is fragmented across too many locations.',
      weak_boundary: 'A module or domain boundary is unclear or poorly placed.',
      god_module: 'One module owns too many independently changing concerns.',
    },
    { priorityWeight: 2 }
  ),
  metric(
    'coupling',
    'Coupling and dependency quality',
    'Judge unnecessary dependencies, dependency direction, leaked details, global state, hidden dependencies, and tight coupling.',
    'Remove or invert the dependency that most strongly leaks details or makes change unsafe.',
    {
      unnecessary_dependency:
        'A dependency is broader or less necessary than the behavior requires.',
      leaked_detail: 'Implementation details leak through a module or API boundary.',
      hidden_dependency: 'A global or implicit dependency makes behavior harder to predict.',
      dependency_direction: 'Dependency direction works against the intended boundary.',
    },
    { priorityWeight: 2 }
  ),
  metric(
    'changeability',
    'Changeability and change amplification',
    'Judge shotgun surgery, scattered rules, duplicated knowledge, hidden dependencies, brittle chains, and edits across unrelated modules.',
    'Centralize the relevant knowledge or boundary so the next conceptual change is predictable.',
    {
      scattered_rule: 'A domain rule or decision is scattered across multiple locations.',
      shotgun_surgery: 'A small conceptual change is likely to require edits in many places.',
      brittle_chain: 'A brittle dependency chain amplifies otherwise local changes.',
      hidden_dependency: 'Hidden dependencies make the impact of a change unpredictable.',
    },
    { priorityWeight: 3 }
  ),
  metric(
    'abstractionQuality',
    'Abstraction and API design',
    'Judge interface simplicity, information hiding, premature abstraction, wrappers, configurability, and leaked details.',
    'Deepen, remove, or reshape the abstraction that adds more surface than value.',
    {
      shallow_wrapper: 'A wrapper or layer adds surface without hiding meaningful complexity.',
      premature_abstraction: 'An abstraction generalizes before the concepts are stable or shared.',
      leaky_api: 'The API exposes details callers should not need to know.',
      overloaded_abstraction: 'One abstraction combines concepts that should vary independently.',
    },
    { priorityWeight: 2 }
  ),
  metric(
    'projectStructure',
    'Project and file structure',
    'Judge navigation, module boundaries, utility dumping grounds, god files, fragmentation, and feature spread.',
    'Move affected code toward a predictable, cohesive location.',
    {
      unpredictable_location:
        'Code is located where future maintainers are unlikely to look for it.',
      utility_dumping_ground: 'General-purpose utility placement hides a domain responsibility.',
      scattered_feature: 'Related feature code is spread across unrelated directories or files.',
      excessive_fragmentation:
        'The structure fragments a cohesive concept without clarifying boundaries.',
    }
  ),
  metric(
    'duplication',
    'Duplication and reuse',
    'Judge duplicated knowledge, repeated business rules, logic that must change together, and missed reuse.',
    'Unify duplicated knowledge where copies represent the same rule.',
    {
      duplicated_rule: 'The same rule or source of truth appears in multiple places.',
      repeated_knowledge: 'Knowledge that should change together is represented independently.',
      missed_existing_reuse:
        'Existing functionality could be reused without inappropriate coupling.',
      forced_reuse: 'Reuse or deduplication creates coupling between separate concepts.',
    }
  ),
  metric(
    'maintainability',
    'Maintainability',
    'Judge the cost of understanding, modifying, debugging, testing, and extending the implementation.',
    'Reduce the highest recurring maintenance cost.',
    {
      understanding_cost: 'The implementation has a high recurring cost to understand.',
      modification_cost: 'Routine modification is likely to be slow or error-prone.',
      debugging_cost: 'Failures would be difficult to isolate and diagnose.',
      extension_cost: 'Expected extension points are awkward or unsafe to use.',
    },
    { priorityWeight: 2 }
  ),
  metric(
    'testQuality',
    'Testability and test quality',
    'Judge behavior coverage, assertions, determinism, isolation, edge and failure cases, and regression protection.',
    'Add or improve the smallest behavior-focused test that protects the important risk.',
    {
      missing_coverage: 'Important changed behavior lacks meaningful regression coverage.',
      weak_assertions: 'Tests execute code without proving the important outcome.',
      brittle_tests: 'Tests are coupled to implementation details or excessive mocking.',
      nondeterminism:
        'Test design or architecture makes results nondeterministic or poorly isolated.',
    },
    { priorityWeight: 2 }
  ),
  metric(
    'reliability',
    'Reliability and error handling',
    'Judge error propagation, invalid states, cleanup, retries, timeouts, races, concurrency, graceful failure, and recovery.',
    'Handle the most credible failure path deliberately.',
    {
      error_propagation:
        'Errors are swallowed, distorted, or propagated without useful boundaries.',
      cleanup: 'A failure path can leave resources or state inconsistent.',
      timeout_retry: 'Timeout or retry behavior is missing, unsafe, or disproportionate.',
      concurrency: 'A race or concurrency assumption threatens reliable behavior.',
    },
    { priorityWeight: 2 }
  ),
  metric(
    'security',
    'Security',
    'Judge trust boundaries, validation, injection, authentication, authorization, secrets, sensitive data, defaults, privileges, and dependencies.',
    'Mitigate the concrete trust-boundary, validation, secret-handling, or privilege risk.',
    {
      input_validation:
        'Untrusted input crosses a boundary without sufficient validation or safe handling.',
      secret_handling: 'Secret or sensitive-data handling creates unnecessary exposure risk.',
      authorization: 'Authentication, authorization, or privilege boundaries appear insufficient.',
      injection: 'Data may reach an interpreter or sensitive sink without appropriate separation.',
    },
    { priorityWeight: 3 }
  ),
  metric(
    'consistency',
    'Consistency and conventions',
    'Judge fit with repository architecture, naming, language idioms, project conventions, and competing implementations.',
    'Align the change with the repository established pattern unless a documented constraint justifies the difference.',
    {
      repository_pattern:
        'The change diverges from an established repository pattern without clear benefit.',
      naming_convention: 'Naming or language idioms conflict with nearby code.',
      competing_pattern:
        'The change introduces a second way to solve an already standardized problem.',
      local_inconsistency: 'Related parts of the change follow inconsistent conventions.',
    }
  ),
  metric(
    'documentation',
    'Documentation and explainability',
    'Judge public contracts, decisions, unusual constraints, configuration, changed APIs, and comments explaining why.',
    'Document the non-obvious contract, constraint, configuration, or rationale.',
    {
      public_contract: 'A public or changed contract is not documented clearly enough.',
      rationale: 'A non-obvious decision or constraint lacks an explanation of why.',
      configuration: 'Required configuration or operational use is insufficiently documented.',
      comment_noise: 'Documentation volume obscures rather than explains important information.',
    }
  ),
  metric(
    'performance',
    'Performance and resource efficiency',
    'Only when relevant, judge algorithmic cost, computation, memory, requests, database access, N+1 patterns, I/O, and repeated work.',
    'Optimize only the evidenced hot path or waste.',
    {
      algorithmic_cost: 'The relevant path has avoidable algorithmic cost.',
      repeated_work: 'Meaningful computation or I/O is repeated unnecessarily.',
      resource_use: 'Memory, network, database, or filesystem use is disproportionate.',
      n_plus_one: 'Work scales per item where it could be performed in a bounded batch.',
    },
    { conditional: true }
  ),
  metric(
    'scalability',
    'Scalability and flexibility',
    'Only when expected growth or change is evidenced, judge whether the implementation can accommodate it.',
    'Address the evidenced growth constraint with the simplest fitting design.',
    {
      growth_bottleneck: 'An evidenced growth dimension reaches a clear implementation bottleneck.',
      rigid_assumption: 'A known variation is blocked by an unnecessarily rigid assumption.',
      speculative_architecture:
        'The design pays complexity now for hypothetical growth without evidence.',
      scaling_boundary:
        'A scaling boundary is placed where work or state cannot be managed predictably.',
    },
    { conditional: true }
  ),
  metric(
    'compatibility',
    'Compatibility and API stability',
    'Only when contracts or integrations are relevant, judge backwards compatibility, public APIs, migrations, breaking changes, interoperability, and version compatibility.',
    'Preserve the affected contract or provide an explicit, tested migration path.',
    {
      breaking_change: 'The change appears to break an existing public or integration contract.',
      migration_gap: 'A required migration or compatibility path is missing.',
      version_assumption:
        'The implementation assumes a version or capability not established by context.',
      interoperability: 'The change reduces interoperability across supported consumers.',
    },
    { conditional: true, priorityWeight: 2 }
  ),
  metric(
    'observability',
    'Observability and operability',
    'Only when operational behavior is relevant, judge logging, metrics, tracing, diagnostics, debugging, and production failure visibility.',
    'Expose the smallest useful diagnostic signal for the credible production failure mode.',
    {
      failure_visibility: 'A credible production failure would not be visible or diagnosable.',
      diagnostic_context: 'Operational signals lack the context needed to act on them.',
      noisy_logging: 'Signals are noisy, sensitive, or too low-value to support operation.',
      missing_measurement: 'A relevant service boundary lacks a useful health or outcome signal.',
    },
    { conditional: true }
  ),
];

export const metricDefinitionByKey = new Map(
  metricDefinitions.map((definition) => [definition.key, definition])
);
