/*
 * Finite semantic-family extension for imported APIs observed as unknown by the
 * real-binary accuracy corpus. This is deliberately not an "any import is
 * known" fallback: every expression below identifies a real ABI/library
 * namespace or an explicitly enumerated libc/POSIX family.
 *
 * `blocks.js::apiInfo()` should consult this table only after its precise table
 * and before returning null. Precise ABI entries therefore keep precedence.
 */

const EXTRA_API_TABLE = [
  // OpenGL ES entry points share the public gl* namespace. Exact argument
  // layouts vary by entry point, so this family claims subsystem/effect only.
  { id:'opengl_es', re:/^_?gl[A-Z][A-Za-z0-9_]*$/, cat:'ui', args:null, ret:null, effect:'ui' },

  // nanopb public C API. These routines encode/decode protobuf wire data.
  { id:'nanopb', re:/^_?pb_[A-Za-z0-9_]+$/, cat:'runtime', args:null, ret:null, effect:'convert' },

  // Security.framework public namespace not already covered by the precise
  // SecKey/SecTrust/SecItem entries in blocks.js.
  { id:'security_framework', re:/^_?Sec[A-Z][A-Za-z0-9_]*$/, cat:'crypto', args:null, ret:null, effect:'crypto' },

  // stdio routines with stable standard/POSIX meaning but heterogeneous ABI.
  { id:'stdio_runtime', re:/^_?(?:fflush|fileno|fputs|fgets|getc|fgetc|ferror|fputc|clearerr|flockfile|ungetc|funlockfile|setvbuf|fscanf|vfprintf|popen|tmpfile|pclose|freopen|setbuf|__srget|ftello)$/, cat:'io', args:null, ret:null, effect:'io' },

  // POSIX/Darwin descriptors, directories and filesystem operations.
  { id:'posix_io', re:/^_?(?:fcntl|fstat|lstat|statfs|fstatfs|opendir|closedir|readdir|readdir_r|scandir|rename|pipe|socketpair|select|getsockname|getpeername|setsockopt|getsockopt|ioctl|kqueue|kevent|dup2|mkstemp|fsync|getcwd|dirfd|nftw|basename|if_nametoindex|gethostname|connectx|symlink|chmod|umask|ftruncate|open_dprotected_np|isatty)$/, cat:'io', args:null, ret:null, effect:'io' },

  // C string/search/conversion APIs missed by the existing narrower table.
  { id:'libc_string', re:/^_?(?:strspn|strcspn|strpbrk|strndup|strcoll|strnstr|strcasestr|memmem|atof|atoll|__strcat_chk|fnmatch)$/, cat:'string', args:null, ret:null, effect:'read' },

  // strtoll/strtoull can store the first unparsed character through endptr.
  { id:'libc_strto', re:/^_?str(?:toll|toull)$/, cat:'string', args:null, ret:null, effect:'write' },

  // Locale/ctype helpers that do not mutate caller-visible or process-global state.
  { id:'libc_locale', re:/^_?(?:__maskrune|__toupper|localeconv)$/, cat:'runtime', args:null, ret:null, effect:'read' },

  // strftime writes the formatted result to its caller-provided destination buffer.
  { id:'libc_strftime', re:/^_?strftime$/, cat:'runtime', args:null, ret:null, effect:'write' },

  // setlocale/tzset mutate process-global locale/timezone runtime state.
  { id:'libc_locale_runtime', re:/^_?(?:setlocale|tzset)$/, cat:'runtime', args:null, ret:null, effect:'runtime' },

  // Remaining scalar libm conversions/operations.
  { id:'libm', re:/^_?(?:acosf?|asinf?|atanf?|tanf?|cosh|sinh|tanh|__exp10f)$/, cat:'runtime', args:null, ret:'number', effect:'read' },

  // C div routines returning struct div_t aggregate { quot, rem }
  { id:'libc_div', re:/^_?(?:div|ldiv|lldiv|imaxdiv)$/, cat:'runtime', args:null, ret:'div_t', effect:'pure' },

  // modf/modff decomposes floating point numbers and stores integer part via output pointer
  { id:'libm_modf', re:/^_?modff?$/, cat:'runtime', args:null, ret:'number', effect:'write' },

  // Explicit C++ ABI exception helpers omitted by the older cxx_runtime regexp.
  { id:'cxx_runtime', re:/^_?__cxa_(?:bad_typeid|bad_cast|current_exception_type)$/, cat:'runtime', args:null, ret:null, effect:'runtime' },

  // Process/signal/terminal identity and non-local-control routines.
  { id:'posix_process', re:/^_?(?:__darwin_check_fd_set_overflow|waitpid|sigsetjmp|setjmp|siglongjmp|__longjmp|__setjmp|sigaltstack|sigprocmask|raise|fork|execl|getuid|getgid|getegid|geteuid|getpwuid_r|tcsetattr|tcgetattr|syscall|sleep|getpagesize|setenv)$/, cat:'runtime', args:null, ret:null, effect:'runtime' },

  { id:'audio_file', re:/^_?AudioFile[A-Za-z0-9_]*$/, cat:'runtime', args:null, ret:null, effect:'runtime' },
  { id:'apple_ui_media', re:/^_?(?:UIApplicationMain|UIRectFill|UIAccessibility[A-Za-z0-9_]*|CAFrameRateRange[A-Za-z0-9_]*|CMSampleBuffer[A-Za-z0-9_]*|CVOpenGLES[A-Za-z0-9_]*|vImage[A-Za-z0-9_]*|UTType[A-Za-z0-9_]*)$/, cat:'ui', args:null, ret:null, effect:'ui' },

  // GoogleUtilities logging exports.
  { id:'google_utilities_log', re:/^_?GUL(?:OSLog|SetLogger|IsLoggable)[A-Za-z0-9_]*$/, cat:'log', args:null, ret:null, effect:'log' },

  { id:'bzip2', re:/^_?BZ2_[A-Za-z0-9_]+$/, cat:'memory', args:null, ret:null, effect:'convert' },

  // Mach-O/runtime introspection APIs and Objective-C property helpers.
  { id:'darwin_runtime', re:/^_?(?:getsectbyname(?:fromheader(?:_64)?)?|NXGetLocalArchInfo|__NSGetEnviron|property_[A-Za-z0-9_]+)$/, cat:'runtime', args:null, ret:null, effect:'runtime' },

  { id:'darwin_notify', re:/^_?notify_[A-Za-z0-9_]+$/, cat:'concurrency', args:null, ret:null, effect:'concurrency' },
  { id:'osatomic', re:/^_?OSAtomic[A-Za-z0-9_]+$/, cat:'concurrency', args:null, ret:null, effect:'concurrency' },
  { id:'resolver', re:/^_?res_9_[A-Za-z0-9_]+$/, cat:'network', args:null, ret:null, effect:'network' },
  { id:'mach_semaphore', re:/^_?semaphore_[A-Za-z0-9_]+$/, cat:'concurrency', args:null, ret:null, effect:'concurrency' },

  // Sanitizer/coredump runtime helpers and Tencent/libpag imported namespace.
  { id:'sanitizer_runtime', re:/^_?(?:detect_gwp_asan|handle_coredump)$/, cat:'runtime', args:null, ret:null, effect:'runtime' },
  { id:'pag_runtime', re:/^_?PAGCode_[A-Za-z0-9_]+$/, cat:'runtime', args:null, ret:null, effect:'runtime' },

  // Finite standard helpers that do not form a useful larger namespace.
  { id:'libc_runtime', re:/^_?(?:qsort|mergesort|atexit|perror|reallocf|close\$NOCANCEL|dlerror|posix_memalign|difftime)$/, cat:'runtime', args:null, ret:null, effect:'runtime' },
  { id:'os_log', re:/^_?__os_log_fault_impl$/, cat:'log', args:null, ret:null, effect:'log' },
];

export function extraApiInfo(name) {
  if (!name) return null;
  const clean = String(name).trim();
  for (const entry of EXTRA_API_TABLE) if (entry.re.test(clean)) return entry;
  return null;
}

export const EXTRA_API_FAMILY_COUNT = EXTRA_API_TABLE.length;
