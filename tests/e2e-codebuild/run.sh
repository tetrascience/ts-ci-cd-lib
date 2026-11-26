#!/usr/bin/env bash
# Tests for the "Start CodeBuild" and "Wait for CodeBuild" steps of e2e-codebuild.yml.
# Each step's script is cut out of the workflow file and run the way the runner runs
# it (`bash -e`), with stub `aws` and `sleep` first on PATH. Needs bash, jq and awk.
# Usage: tests/e2e-codebuild/run.sh [path/to/e2e-codebuild.yml]
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
WORKFLOW="${1:-$HERE/../../.github/workflows/e2e-codebuild.yml}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/e2e-codebuild-tests.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

bash "$HERE/extract-step.sh" "$WORKFLOW" "Start CodeBuild" > "$WORK/start.sh"
bash "$HERE/extract-step.sh" "$WORKFLOW" "Wait for CodeBuild" > "$WORK/wait.sh"
# The stubs are installed here, so the checkout needs no executable bits.
mkdir "$WORK/bin"
for stub in aws sleep; do
  cp "$HERE/stubs/$stub" "$WORK/bin/$stub"
  chmod +x "$WORK/bin/$stub"
done
if [[ ! -s "$WORK/start.sh" || ! -s "$WORK/wait.sh" ]]; then
  echo "Could not extract the step scripts from $WORKFLOW" >&2
  exit 2
fi
echo "bash ${BASH_VERSION}, $(jq --version)"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $1"; }
# check <description> <bash condition, evaluated here>
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Awkward on purpose: quotes, %, a newline, shell syntax, a leading dash.
JF='jf r0g:"S3cr3t" 100%/+=='
ZT=$'zephyr-TOKEN-line1\nline2-ZZZ'
PW='-file://pw$(id)`x`'\''q'
repeat() { local out; printf -v out '%*s' "$2" ''; printf '%s' "${out// /$1}"; }

# run <case> [VAR=VALUE...]: a fresh directory and a clean environment per case.
run() {
  CASE="$1"
  shift
  W="$WORK/$CASE"
  mkdir -p "$W/tmp"
  : > "$W/argv.log"; : > "$W/puts.log"; : > "$W/sleep.log"; : > "$W/gh_output"; : > "$W/summary"
  # shellcheck disable=SC2086  # BASH_FLAGS is split on purpose
  env -i PATH="$WORK/bin:$PATH" HOME="$W" STUB_DIR="$W" RUNNER_TEMP="$W/tmp" \
    GITHUB_OUTPUT="$W/gh_output" GITHUB_STEP_SUMMARY="$W/summary" \
    TARGET_ENV=predev5 JFROG_URL=https://jfrog.example/npm S3_LOCATION=bkt/o/r/sha.zip \
    BUILDSPEC_PATH=buildspec.e2e.yml IMAGE_OVERRIDE= COMPUTE_TYPE_OVERRIDE= \
    BUILD_TIMEOUT_MINUTES=0 JOB_TIMEOUT_MINUTES=25 PASSTHROUGH_ENV= ENV_VARS_JSON='{}' \
    CALLER_REPOSITORY=tetrascience/ts-service-data-apps TARGET_ACCOUNT=734018046548 \
    TARGET_REGION=us-east-2 TARGET_CF_ENV=development ALLOW_PLAINTEXT_FALLBACK=true \
    "$@" ${BASH_FLAGS:-bash -e} "$WORK/${SCRIPT:-start.sh}" > "$W/out" 2>&1
  RC=$?
  ENVJ="$W/start-env.json"
}
started() { grep -q 'codebuild\] \[start-build' "$W/argv.log"; }
puts() { grep -c 'ssm\] \[put-parameter' "$W/argv.log"; }
sleeps() { wc -l < "$W/sleep.log" | tr -d ' '; }
# "<TYPE>=<value>" of one variable in the start-build request, empty when absent.
sent() { jq -r --arg n "$1" '.[] | select(.name == $n) | "\(.type // "PLAINTEXT")=\(.value)"' "$ENVJ" 2>/dev/null; }
names() { jq -r 'map(.name) | sort | join(",")' "$ENVJ"; }
# No secret value in any argv, the step's output, GITHUB_OUTPUT or the step summary.
no_leak() {
  local s f
  for s in "$JF" "$PW" "zephyr-TOKEN-line1" "line2-ZZZ"; do
    for f in argv.log out gh_output summary; do
      if grep -qF -- "$s" "$W/$f"; then
        bad "$CASE: secret found in $f"
        return
      fi
    done
  done
  ok "$CASE: no secret in argv / output / GITHUB_OUTPUT / step summary"
}
tmp_clean() { check "$CASE: temp dir removed on exit" '[[ -z "$(ls -A "$W/tmp")" ]]'; }
failed_before_build() {
  check "$CASE: non-zero exit, start-build never called" '[[ $RC -ne 0 ]] && ! started'
  check "$CASE: no PLAINTEXT fallback" '! grep -q "::warning::" "$W/out" && [[ ! -s "$W/summary" ]]'
}
REF=/tdp/e2e/ci/ts-service-data-apps

echo "1. all three secrets, put succeeds"
run all JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT" E2E_USER_PASSWORD="$PW"
check "all: exit 0" '[[ $RC -eq 0 ]]'
check "all: 3 puts, then start-build" '[[ "$(puts)" == 3 && "$(tail -1 "$W/argv.log")" == *start-build* ]]'
check "all: JFROG reference" '[[ "$(sent JFROG_ARTIFACTORY_AUTH)" == "PARAMETER_STORE=$REF/jfrog-npm-read-auth" ]]'
check "all: ZEPHYR reference" '[[ "$(sent ZEPHYR_API_TOKEN)" == "PARAMETER_STORE=$REF/zephyr-api-token" ]]'
check "all: PASSWORD reference" '[[ "$(sent E2E_USER_PASSWORD)" == "PARAMETER_STORE=$REF/e2e-user-password" ]]'
check "all: put flags" 'grep -q "\[--type\] \[SecureString\] \[--overwrite\] \[--value\] \[file://" "$W/argv.log"'
check "all: stored values byte-exact" '[[ "$(cat "$W/put.jfrog-npm-read-auth.value")" == "$JF" && "$(cat "$W/put.zephyr-api-token.value")" == "$ZT" && "$(cat "$W/put.e2e-user-password.value")" == "$PW" ]]'
check "all: no trailing newline added" '[[ "$(wc -c < "$W/put.jfrog-npm-read-auth.value" | tr -d " ")" == "${#JF}" ]]'
check "all: value passed as file://, 0600 file in 0700 dir" '[[ "$(grep -c "file=-rw------- dir=drwx------" "$W/puts.log")" == 3 ]] && ! grep -q NOT_FILE "$W/puts.log"'
check "all: overrides passed as a 0600 file" 'grep -q "ENVFILE file=-rw-------" "$W/puts.log"'
check "all: log line is NAME:TYPE" 'grep -q "^CodeBuild env: .*JFROG_ARTIFACTORY_AUTH:PARAMETER_STORE" "$W/out" && grep -q "E2E_ENVIRONMENT:PLAINTEXT" "$W/out"'
check "all: no warning, no summary, no retry" '! grep -q "::warning::" "$W/out" && [[ ! -s "$W/summary" && "$(sleeps)" == 0 ]]'
check "all: build_id output" 'grep -q "^build_id=tdp-e2e:11111111-2222$" "$W/gh_output"'
no_leak
tmp_clean

echo "2. xtrace forced on (bash -ex): set +x keeps values out of the trace"
BASH_FLAGS="bash -ex" run xtrace JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT" E2E_USER_PASSWORD="$PW"
check "xtrace: exit 0" '[[ $RC -eq 0 ]]'
no_leak
BASH_FLAGS="bash -ex" run xtrace-denied STUB_PUT=denied JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT" E2E_USER_PASSWORD="$PW"
check "xtrace-denied: exit 0" '[[ $RC -eq 0 ]]'
no_leak

echo "3. empty or absent secrets: same request as before this change"
run empty JFROG_AUTH= ZEPHYR_API_TOKEN=
check "empty: exit 0, build started, nothing written to SSM" '[[ $RC -eq 0 ]] && started && [[ "$(puts)" == 0 ]]'
check "empty: JFROG_ARTIFACTORY_AUTH still sent, empty" '[[ "$(sent JFROG_ARTIFACTORY_AUTH)" == "PLAINTEXT=" ]]'
check "empty: Zephyr token and password absent" '[[ "$(names)" == "E2E_ENVIRONMENT,JFROG_ARTIFACTORY_AUTH,JFROG_ARTIFACTORY_URL" ]]'
check "empty: logged as empty, no warning" 'grep -q "JFROG_ARTIFACTORY_AUTH:PLAINTEXT(empty)" "$W/out" && ! grep -q "::warning::" "$W/out"'
tmp_clean

echo "4. credential names are reserved even when the secret is empty"
run reserved-empty JFROG_AUTH= PASSTHROUGH_ENV=$'JFROG_ARTIFACTORY_AUTH=from-passthrough\nFOO=bar' \
  ENV_VARS_JSON='{"E2E_USER_PASSWORD":"from-var","E2E_ORG":"acme","ZEPHYR_API_TOKEN":"not-e2e"}'
check "reserved-empty: passthrough cannot supply JFROG_ARTIFACTORY_AUTH" '[[ "$(sent JFROG_ARTIFACTORY_AUTH)" == "PLAINTEXT=" ]]'
check "reserved-empty: no credential comes from passthrough or Environment vars" '[[ -z "$(sent E2E_USER_PASSWORD)$(sent ZEPHYR_API_TOKEN)" ]] && ! grep -q -e from-passthrough -e from-var -e not-e2e "$ENVJ"'
check "reserved-empty: other vars still forwarded" '[[ "$(sent FOO)" == "PLAINTEXT=bar" && "$(sent E2E_ORG)" == "PLAINTEXT=acme" ]]'
run reserved-set JFROG_AUTH="$JF" E2E_USER_PASSWORD="$PW" \
  PASSTHROUGH_ENV=$'JFROG_ARTIFACTORY_AUTH=shadow\nE2E_ENVIRONMENT=evil' ENV_VARS_JSON='{"E2E_USER_PASSWORD":"from-var"}'
check "reserved-set: references win" '[[ "$(sent JFROG_ARTIFACTORY_AUTH)" == PARAMETER_STORE=* && "$(sent E2E_USER_PASSWORD)" == PARAMETER_STORE=* ]] && ! grep -q -e shadow -e from-var "$ENVJ"'
check "reserved-set: E2E_ENVIRONMENT wins" '[[ "$(sent E2E_ENVIRONMENT)" == "PLAINTEXT=predev5" ]]'
check "reserved-set: no duplicate names" '[[ "$(jq "map(.name) | length" "$ENVJ")" == "$(jq "map(.name) | unique | length" "$ENVJ")" ]]'
run reserved-denied STUB_PUT=denied JFROG_AUTH="$JF" PASSTHROUGH_ENV='JFROG_ARTIFACTORY_AUTH=shadow'
check "reserved-denied: fallback value wins over passthrough" '[[ "$(sent JFROG_ARTIFACTORY_AUTH)" == "PLAINTEXT=$JF" ]]'

echo "5. the role lacks ssm:PutParameter -> PLAINTEXT fallback, warning, step summary"
for mode in denied denied-short; do
  run "fb-$mode" STUB_PUT=$mode JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT" E2E_USER_PASSWORD="$PW"
  check "$CASE: exit 0, build started, one put each" '[[ $RC -eq 0 ]] && started && [[ "$(puts)" == 3 ]]'
  check "$CASE: values exact, including the multi-line one" '[[ "$(sent JFROG_ARTIFACTORY_AUTH)" == "PLAINTEXT=$JF" && "$(sent ZEPHYR_API_TOKEN)" == "PLAINTEXT=$ZT" && "$(sent E2E_USER_PASSWORD)" == "PLAINTEXT=$PW" ]]'
  check "$CASE: 3 warnings: variable, build record, role, permission, AWS message" '[[ "$(grep -c "^::warning::[A-Z0-9_]* is sent to CodeBuild as PLAINTEXT.*build record.*gha-tdp-e2e-development.*734018046548.*ssm:PutParameter on parameter/tdp/e2e/ci/\*.*AWS said: .*is not authorized to perform: ssm:PutParameter on resource" "$W/out")" == 3 ]]'
  check "$CASE: step summary names each variable and the permission" '[[ "$(wc -l < "$W/summary" | tr -d " ")" == 3 ]] && grep -q "E2E_USER_PASSWORD.*ssm:PutParameter" "$W/summary" && grep -q "JFROG_ARTIFACTORY_AUTH" "$W/summary"'
  check "$CASE: logged as PLAINTEXT" 'grep -q "JFROG_ARTIFACTORY_AUTH:PLAINTEXT " "$W/out"'
  no_leak
  tmp_clean
done
run fb-mixed STUB_PUT_jfrog_npm_read_auth=denied JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT" E2E_USER_PASSWORD="$PW"
check "fb-mixed: only the denied variable falls back" '[[ "$(sent JFROG_ARTIFACTORY_AUTH)" == "PLAINTEXT=$JF" && "$(sent ZEPHYR_API_TOKEN)" == PARAMETER_STORE=* && "$(sent E2E_USER_PASSWORD)" == PARAMETER_STORE=* ]]'
check "fb-mixed: exactly one warning and one summary line" '[[ "$(grep -c "::warning::" "$W/out")" == 1 && "$(wc -l < "$W/summary" | tr -d " ")" == 1 ]]'
no_leak

echo "6. allow_plaintext_fallback: false"
run nofb-denied ALLOW_PLAINTEXT_FALLBACK=false STUB_PUT=denied JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT"
failed_before_build
check "$CASE: error names the variable, the permission and the input" 'grep -q "^::error::Could not store JFROG_ARTIFACTORY_AUTH in SSM parameter $REF/jfrog-npm-read-auth: .*ssm:PutParameter on parameter/tdp/e2e/ci/\*, and allow_plaintext_fallback is false. AWS said: " "$W/out"'
no_leak
tmp_clean
run nofb-ok ALLOW_PLAINTEXT_FALLBACK=false JFROG_AUTH="$JF"
check "$CASE: a successful put is unaffected" '[[ $RC -eq 0 && "$(sent JFROG_ARTIFACTORY_AUTH)" == PARAMETER_STORE=* ]]'

echo "7. any other denial or failure stops the run before start-build"
for mode in kms explicit scp boundary othercall validation network; do
  run "fail-$mode" STUB_PUT=$mode JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT"
  failed_before_build
  check "$CASE: ::error:: names variable and parameter, carries the AWS message" 'grep -q "^::error::Could not store JFROG_ARTIFACTORY_AUTH in SSM parameter $REF/jfrog-npm-read-auth (.*)\. AWS said: ..*" "$W/out"'
  check "$CASE: stopped at the first failure, no retry" '[[ "$(puts)" == 1 && "$(sleeps)" == 0 ]]'
  no_leak
  tmp_clean
done
check "kms: reported as access denied, with the kms action" 'grep -q "(AccessDeniedException)\. AWS said: .*kms:GenerateDataKey" "$WORK/fail-kms/out"'
check "explicit: the explicit deny is in the message" 'grep -q "explicit deny in a service control policy" "$WORK/fail-explicit/out"'
check "validation: echoed value masked, % escaped, one line" 'grep -q "100%25 bad value \*\*\*$" "$WORK/fail-validation/out"'
check "network / othercall: no code to report" 'grep -q "(no AWS error code)" "$WORK/fail-network/out" && grep -q "(no AWS error code)" "$WORK/fail-othercall/out"'

echo "8. TooManyUpdates and throttling are retried, with a cap"
run retry-ok STUB_PUT=toomany,throttle,ok JFROG_AUTH="$JF"
check "$CASE: succeeds on the third attempt" '[[ $RC -eq 0 && "$(puts)" == 3 && "$(sent JFROG_ARTIFACTORY_AUTH)" == PARAMETER_STORE=* ]]'
check "$CASE: two growing, jittered waits" '[[ "$(sleeps)" == 2 ]] && s1=$(sed -n 1p "$W/sleep.log") && s2=$(sed -n 2p "$W/sleep.log") && (( s1 >= 2 && s1 <= 5 && s2 >= 4 && s2 <= 7 ))'
check "$CASE: retries are logged, no warning" '[[ "$(grep -c "retrying" "$W/out")" == 2 ]] && ! grep -q "::warning::" "$W/out"'
no_leak
run retry-last STUB_PUT=throttle,throttle,throttle,throttle,ok JFROG_AUTH="$JF"
check "$CASE: succeeds on the fifth attempt" '[[ $RC -eq 0 && "$(puts)" == 5 && "$(sleeps)" == 4 ]]'
for mode in toomany throttle; do
  run "retry-cap-$mode" STUB_PUT=$mode JFROG_AUTH="$JF" ZEPHYR_API_TOKEN="$ZT"
  failed_before_build
  check "$CASE: gives up after 5 attempts and 4 waits" '[[ "$(puts)" == 5 && "$(sleeps)" == 4 ]]'
  no_leak
  tmp_clean
done
check "retry-cap: the code is reported" 'grep -q "^::error::Could not store JFROG_ARTIFACTORY_AUTH .*(TooManyUpdates)" "$WORK/retry-cap-toomany/out" && grep -q "(ThrottlingException)" "$WORK/retry-cap-throttle/out"'
run retry-then-denied STUB_PUT=toomany,denied JFROG_AUTH="$JF"
check "$CASE: a denial after a retry still falls back" '[[ $RC -eq 0 && "$(puts)" == 2 && "$(sent JFROG_ARTIFACTORY_AUTH)" == "PLAINTEXT=$JF" ]]'

echo "9. the 4096-byte Standard-tier limit"
AT_LIMIT=$(repeat a 4096)
run len-4096 JFROG_AUTH="$AT_LIMIT"
check "$CASE: accepted and stored whole" '[[ $RC -eq 0 && "$(wc -c < "$W/put.jfrog-npm-read-auth.value" | tr -d " ")" == 4096 && "$(sent JFROG_ARTIFACTORY_AUTH)" == PARAMETER_STORE=* ]]'
run len-4097 JFROG_AUTH="${AT_LIMIT}b" ZEPHYR_API_TOKEN="$ZT"
failed_before_build
check "$CASE: nothing written" '[[ "$(puts)" == 0 ]]'
check "$CASE: error names the variable, the size and the limit, not the value" 'grep -q "^::error::JFROG_ARTIFACTORY_AUTH is 4097 bytes, more than the 4096 " "$W/out" && ! grep -q "aaaaaaaa" "$W/out"'
tmp_clean
run len-multibyte E2E_USER_PASSWORD="$(repeat é 2049)"
check "$CASE: counted in bytes (2049 two-byte characters rejected)" '[[ $RC -ne 0 ]] && ! started && grep -q "^::error::E2E_USER_PASSWORD is 4098 bytes" "$W/out"'
run len-denied STUB_PUT=denied JFROG_AUTH="${AT_LIMIT}b"
check "$CASE: too long never reaches the fallback" '[[ $RC -ne 0 ]] && ! started && [[ "$(puts)" == 0 ]]'

echo "10. repository names"
for r in "tetrascience/ts-lib-ui-kit" "o/a.b_c-D9" "o/$(repeat a 100)"; do
  run repo-ok CALLER_REPOSITORY="$r" JFROG_AUTH="$JF"
  check "valid repo '${r:0:40}'" '[[ $RC -eq 0 && "$(sent JFROG_ARTIFACTORY_AUTH)" == "PARAMETER_STORE=/tdp/e2e/ci/${r#*/}/jfrog-npm-read-auth" ]]'
done
i=0
for r in "o/.." "o/." "o/re po" "o/a/b" "o/" "" "noslash/../x" "o/..%2f" 'o/$(id)' "o/a;b" "o/répo" $'o/a\nb' "o/a*" "o/$(repeat a 101)"; do
  i=$((i + 1))
  run "repo-bad-$i" CALLER_REPOSITORY="$r" JFROG_AUTH="$JF"
  check "bad repo #$i rejected, no put, no start-build" '[[ $RC -ne 0 && "$(puts)" == 0 ]] && ! started && grep -q "^::error::Cannot derive an SSM parameter name" "$W/out"'
done
run repo-bad-nosecret CALLER_REPOSITORY="o/re po" JFROG_AUTH=
check "a bad repo name is irrelevant when no secret is supplied" '[[ $RC -eq 0 ]] && started'

echo "11. unchanged behaviour"
run zephyr-ids ZEPHYR_CYCLE_KEY=SW-R12 ZEPHYR_ACCOUNT_ID=abc123
check "cycle key / account id stay PLAINTEXT, no put" '[[ "$(sent ZEPHYR_CYCLE_KEY)" == "PLAINTEXT=SW-R12" && "$(sent ZEPHYR_ACCOUNT_ID)" == "PLAINTEXT=abc123" && "$(puts)" == 0 ]]'
run timeout BUILD_TIMEOUT_MINUTES=30 JOB_TIMEOUT_MINUTES=25 JFROG_AUTH="$JF"
check "bad timeout still rejected before start-build" '[[ $RC -ne 0 ]] && ! started'
tmp_clean
run secretlike PASSTHROUGH_ENV='MY_API_TOKEN=x'
check "secret-like passthrough name still rejected" '[[ $RC -ne 0 ]] && ! started'
run overrides IMAGE_OVERRIDE=img:1 COMPUTE_TYPE_OVERRIDE=BUILD_GENERAL1_MEDIUM BUILD_TIMEOUT_MINUTES=20 JFROG_AUTH="$JF"
check "image / compute / timeout overrides still passed" 'grep -q "\[--image-override\] \[img:1\] \[--compute-type-override\] \[BUILD_GENERAL1_MEDIUM\] \[--timeout-in-minutes-override\] \[20\]" "$W/argv.log"'

echo "12. Wait for CodeBuild: failing phase report"
cat > "$WORK/failed.json" <<'EOF'
{"builds":[{"buildStatus":"FAILED","logs":{"groupName":null,"streamName":null,"deepLink":"https://logs.example"},
 "phases":[{"phaseType":"SUBMITTED","phaseStatus":"SUCCEEDED"},
  {"phaseType":"PROVISIONING","phaseStatus":"CLIENT_ERROR","contexts":[
   {"statusCode":"PARAMETER_STORE_ERROR","message":"Parameter does not exist: /tdp/e2e/ci/r/x\n::warning::injected\r\n::set-output name=a::b 100% done"},
   {"message":"second"}]},
  {"phaseType":"COMPLETED"}]}]}
EOF
SCRIPT=wait.sh run wait-failed STUB_BUILDINFO="$WORK/failed.json" BUILD_ID=tdp-e2e:1 TIMEOUT=25
check "$CASE: exit 0, status recorded" '[[ $RC -eq 0 ]] && grep -q "^build_status=FAILED$" "$W/gh_output"'
check "$CASE: phase and reason on ONE ::error:: line" '[[ "$(grep -c "" "$W/out")" == 1 ]] && grep -q "^::error::CodeBuild PROVISIONING CLIENT_ERROR: Parameter does not exist: /tdp/e2e/ci/r/x ::warning::injected ::set-output name=a::b 100%25 done; second$" "$W/out"'
check "$CASE: no line starts an injected workflow command" '! grep -q -e "^::warning::" -e "^::set-output" "$W/out"'
echo '{"builds":[{"buildStatus":"SUCCEEDED","logs":{"groupName":"g","streamName":"s","deepLink":"https://logs.example"},"phases":[{"phaseType":"BUILD","phaseStatus":"SUCCEEDED"},{"phaseType":"COMPLETED"}]}]}' > "$WORK/succeeded.json"
SCRIPT=wait.sh run wait-ok STUB_BUILDINFO="$WORK/succeeded.json" BUILD_ID=tdp-e2e:1 TIMEOUT=25
check "$CASE: a SUCCEEDED build prints nothing extra" '[[ $RC -eq 0 && ! -s "$W/out" ]] && grep -q "^build_status=SUCCEEDED$" "$W/gh_output"'

echo
echo "PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
