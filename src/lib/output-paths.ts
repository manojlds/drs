export const OUTPUT_PATHS = {
  describe_output: '.drs/describe-output.json',
  review_output: '.drs/review-output.json',
} as const;

export type OutputType = keyof typeof OUTPUT_PATHS;
