export const OUTPUT_PATHS = {
  describe_output: '.drs/describe-output.json',
} as const;

export type OutputType = keyof typeof OUTPUT_PATHS;
