/** What `taskfollow why` and `why.show` (D169) accept; a leaf module, so the tool can check arguments without loading why.ts. */
export const RUN_ID = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}$/;
export const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
