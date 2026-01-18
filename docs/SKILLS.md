# Skills Support

DRS supports [Agent Skills](https://agentskills.io) - a standardized way to provide domain-specific knowledge, instructions, and context to review agents.

## Overview

Skills are folders containing `SKILL.md` files that define reusable knowledge and instructions for AI agents. When enabled, DRS agents can access these skills during code reviews to apply project-specific rules, best practices, and domain knowledge.

## Why Use Skills?

### Benefits

- **Consistent Reviews**: Ensure all agents follow the same standards
- **Domain Knowledge**: Provide context about frameworks, libraries, or architectures
- **Project-Specific Rules**: Encode requirements unique to your project
- **Team Standards**: Share coding conventions across the team
- **Reusability**: Use the same skills across different agents
- **Maintainability**: Update standards in one place

### Use Cases

1. **Company Coding Standards**: Document and enforce company-wide coding practices
2. **Framework Patterns**: Provide guidance on using specific frameworks (React, Vue, etc.)
3. **Security Guidelines**: Share security best practices and common vulnerabilities
4. **Testing Requirements**: Define what makes good test coverage
5. **Architecture Patterns**: Document preferred architectural approaches
6. **API Design**: Standardize API design patterns
7. **Performance Guidelines**: Share performance optimization techniques

## Directory Structure

Skills are organized in subdirectories under `.drs/skills/`:

```
.drs/
└── skills/
    ├── code-review-best-practices/
    │   └── SKILL.md
    ├── security-patterns/
    │   └── SKILL.md
    ├── testing-guidelines/
    │   └── SKILL.md
    └── company-standards/
        └── SKILL.md
```

Each skill directory must contain a `SKILL.md` file.

## Creating Skills

### Basic Skill Structure

A skill is a markdown file (`SKILL.md`) that can include:

- Instructions and guidelines
- Code examples (good and bad)
- References to documentation
- Project-specific rules
- Best practices

### Example: Code Review Best Practices

```markdown
# Code Review Best Practices

## Instructions

When reviewing code, always check for:

1. **Error Handling**: Ensure all external calls have proper error handling
2. **Testing**: New features should include tests
3. **Documentation**: Public APIs must be documented
4. **Performance**: Avoid unnecessary loops and allocations

## Project-Specific Rules

- All database queries must use parameterized queries
- API responses must include proper error codes
- All user inputs must be validated
- Use TypeScript strict mode for all new code

## Examples

### Good: Proper Error Handling

\`\`\`typescript
async function fetchUser(id: string): Promise<User> {
  try {
    const response = await api.get(\`/users/\${id}\`);
    return response.data;
  } catch (error) {
    logger.error('Failed to fetch user', { id, error });
    throw new UserFetchError(\`User \${id} not found\`, { cause: error });
  }
}
\`\`\`

### Bad: Missing Error Handling

\`\`\`typescript
async function fetchUser(id: string): Promise<User> {
  const response = await api.get(\`/users/\${id}\`);
  return response.data;
}
\`\`\`

## References

- [Internal API Guidelines](https://wiki.company.com/api-guidelines)
- [Testing Standards](https://wiki.company.com/testing)
```

### Example: Security Patterns

```markdown
# Security Patterns

## Authentication

### JWT Tokens

Always validate:
- Token signature
- Token expiration
- Token issuer
- Token audience

Example:
\`\`\`typescript
function validateJWT(token: string): TokenPayload {
  const decoded = jwt.verify(token, process.env.JWT_SECRET, {
    issuer: 'api.company.com',
    audience: 'web-app',
    algorithms: ['HS256']
  });

  if (decoded.exp < Date.now() / 1000) {
    throw new TokenExpiredError();
  }

  return decoded;
}
\`\`\`

## Input Validation

All user input must be:
1. Type-validated
2. Length-checked
3. Sanitized for XSS
4. Validated against business rules

### Example: Input Validation

\`\`\`typescript
import { z } from 'zod';

const userSchema = z.object({
  email: z.string().email().max(255),
  name: z.string().min(1).max(100),
  age: z.number().int().positive().max(150)
});

function validateUserInput(data: unknown): User {
  return userSchema.parse(data);
}
\`\`\`

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Company Security Wiki](https://wiki.company.com/security)
```

## Configuration

### Global Configuration

Enable skills for all agents in `.drs/drs.config.yaml`:

```yaml
skills:
  enabled: true                    # Enable/disable skills (default: true)
  directory: .drs/skills           # Skills directory (default: .drs/skills)
  global:                          # Skills available to all agents
    - code-review-best-practices
    - company-standards
    - security-patterns
```

### Per-Agent Configuration

Configure skills for specific agents:

```yaml
review:
  agents:
    # Simple agent config - uses global skills only
    - security

    # Agent with specific skills
    - name: quality
      model: anthropic/claude-sonnet-4-5-20250929
      skills:
        - testing-guidelines
        - architecture-patterns

    # Agent using both global and specific skills
    - name: style
      skills:
        - naming-conventions
        - formatting-rules

    # Agent with no additional skills (only global)
    - name: performance
```

### Environment Variables

Configure skills via environment variables:

```bash
# Enable/disable skills globally
export SKILLS_ENABLED=true

# Use custom skills directory
export SKILLS_DIRECTORY=custom/skills

# Set global skills (comma-separated)
export SKILLS_GLOBAL=skill1,skill2,skill3
```

## How Skills Work

### 1. Discovery

When a review is started, DRS:
1. Checks if skills are enabled (`skills.enabled`)
2. Scans the skills directory (`skills.directory`)
3. Loads all subdirectories containing `SKILL.md` files

### 2. Selection

For each agent, DRS determines which skills to use:
1. Starts with global skills (`skills.global`)
2. Adds agent-specific skills (from `agents[].skills`)
3. Deduplicates the list

### 3. Loading

Selected skills are:
1. Read from their `SKILL.md` files
2. Combined into a skills context
3. Injected into the agent prompt

### 4. Integration

The skills context is added to the agent prompt in this order:

```
1. Global project context (.drs/context.md)
2. Agent-specific context (.drs/agents/{agent}/context.md)
3. Skills context (from enabled skills)
4. Base agent instructions
```

### 5. Application

During review, agents:
1. Read the skills context
2. Apply the guidelines and rules
3. Use examples as reference
4. Follow project-specific patterns

## Best Practices

### Skill Organization

1. **One Topic Per Skill**: Keep skills focused on a single domain
2. **Clear Structure**: Use headings and sections for organization
3. **Include Examples**: Show both good and bad code patterns
4. **Reference Documentation**: Link to official docs and internal wikis
5. **Keep Updated**: Review and update skills regularly

### Skill Naming

Use descriptive, kebab-case names:
- ✅ `code-review-best-practices`
- ✅ `security-patterns`
- ✅ `testing-guidelines`
- ❌ `skill1`
- ❌ `MySkill`

### Content Guidelines

1. **Be Specific**: Provide concrete, actionable guidance
2. **Use Examples**: Include code snippets showing good/bad patterns
3. **Explain Why**: Don't just say what to do, explain the reasoning
4. **Keep Concise**: Skills should be focused and scannable
5. **Update Regularly**: Keep skills current with project evolution

### Distribution

1. **Global Skills**: Use for company-wide standards
2. **Agent-Specific Skills**: Use for domain-specific knowledge
3. **Project Skills**: Keep in project repository
4. **Shared Skills**: Consider sharing across projects via git submodules or symlinks

## Examples

### Testing Guidelines Skill

```markdown
# Testing Guidelines

## Test Coverage Requirements

All new features must include:
- Unit tests (>80% coverage)
- Integration tests for API endpoints
- E2E tests for critical user flows

## Test Structure

Follow AAA pattern (Arrange, Act, Assert):

\`\`\`typescript
describe('UserService', () => {
  it('should create a user with valid data', async () => {
    // Arrange
    const userData = { email: 'test@example.com', name: 'Test User' };
    const mockRepository = createMockRepository();
    const service = new UserService(mockRepository);

    // Act
    const result = await service.createUser(userData);

    // Assert
    expect(result).toMatchObject(userData);
    expect(mockRepository.save).toHaveBeenCalledWith(userData);
  });
});
\`\`\`

## Mock Guidelines

- Use dependency injection for testability
- Mock external services (APIs, databases)
- Don't mock internal logic
- Reset mocks between tests

## References

- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
```

### Architecture Patterns Skill

```markdown
# Architecture Patterns

## Layered Architecture

Our applications use a 3-layer architecture:

1. **Controllers**: Handle HTTP requests/responses
2. **Services**: Contain business logic
3. **Repositories**: Handle data access

### Example Structure

\`\`\`typescript
// Controller (thin, delegates to service)
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Post()
  async create(@Body() data: CreateUserDto) {
    return this.userService.createUser(data);
  }
}

// Service (business logic)
export class UserService {
  constructor(private readonly userRepository: UserRepository) {}

  async createUser(data: CreateUserDto): Promise<User> {
    // Validation
    if (!isValidEmail(data.email)) {
      throw new BadRequestException('Invalid email');
    }

    // Business logic
    const user = await this.userRepository.create(data);
    await this.emailService.sendWelcomeEmail(user);

    return user;
  }
}

// Repository (data access)
export class UserRepository {
  constructor(private readonly db: Database) {}

  async create(data: CreateUserDto): Promise<User> {
    return this.db.users.create({ data });
  }
}
\`\`\`

## Dependency Injection

- Always use constructor injection
- Inject interfaces, not concrete classes
- Use dependency injection container

## Error Handling

Controllers should catch service errors and return appropriate HTTP responses:

\`\`\`typescript
try {
  return await this.userService.createUser(data);
} catch (error) {
  if (error instanceof ValidationError) {
    throw new BadRequestException(error.message);
  }
  if (error instanceof NotFoundError) {
    throw new NotFoundException(error.message);
  }
  throw new InternalServerErrorException('Failed to create user');
}
\`\`\`
```

## Troubleshooting

### Skills Not Loading

Check:
1. Skills are enabled: `skills.enabled: true`
2. Directory exists: `.drs/skills/`
3. Each skill has a `SKILL.md` file
4. Skill names match configuration
5. No permission issues reading files

### Skills Not Applied

Check:
1. Skills are properly configured for the agent
2. Agent prompt includes skills context (use `--debug` flag)
3. Skill content is valid markdown
4. No syntax errors in SKILL.md files

### Debug Output

Use the `--debug` flag to see the full prompt sent to agents:

```bash
drs review-local --debug
```

This will show:
- Which skills were loaded
- The complete prompt including skills context
- Agent responses

## Migration Guide

### From Agent Context to Skills

If you're currently using `.drs/agents/{agent}/context.md`, you can migrate to skills:

1. **Identify Reusable Content**: Find content that applies to multiple agents
2. **Create Skills**: Extract reusable content into skills
3. **Configure**: Update config to use skills instead of context
4. **Test**: Verify reviews work as expected

Example migration:

**Before** (`.drs/agents/security/context.md`):
```markdown
Check for SQL injection vulnerabilities.
All queries must use parameterized queries.
```

**After** (`.drs/skills/security-patterns/SKILL.md`):
```markdown
# Security Patterns

## SQL Injection Prevention

All database queries must use parameterized queries.

### Good
\`\`\`typescript
db.query('SELECT * FROM users WHERE id = ?', [userId]);
\`\`\`

### Bad
\`\`\`typescript
db.query(\`SELECT * FROM users WHERE id = \${userId}\`);
\`\`\`
```

**Config**:
```yaml
skills:
  global:
    - security-patterns
```

## Related Resources

- [Agent Skills Official Site](https://agentskills.io)
- [SKILL.md Specification](https://agentskills.io/spec)
- [DRS Documentation](../README.md)
- [Agent Customization](../README.md#customization)
