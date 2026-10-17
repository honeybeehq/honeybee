import collections

VERDICTS = ('scope_proven_exiting', 'prior_target_outside_hive', 'masked_unknown_prior_WARN', 'FAIL')


def error_summary(errors, diagnostic_reads=(), observation_retries=()):
    primary = [error for error in errors if error.get('slot') != 'atErrorStat']
    diagnostic = [error for error in errors if error.get('slot') == 'atErrorStat']
    def counts(records):
        result = dict.fromkeys(VERDICTS, 0)
        for error in records:
            result[error['verdict']] += 1
        return result
    def errnos(records):
        result = collections.defaultdict(collections.Counter)
        for error in records:
            result[str(error.get('errno'))][error['verdict']] += 1
        return {number: dict(values) for number, values in result.items()}
    pc, dc = counts(primary), counts(diagnostic)
    retries = [attempt for observation in observation_retries for attempt in observation['statObservationAttempts'][1:]]
    failed_retries = sum(not (attempt.get('procStat') or {}).get('state') for attempt in retries)
    failed_reads = [read for read in diagnostic_reads if not (read.get('procStat') or {}).get('state')]
    embedded = sum(read.get('threadScoped', False) for read in failed_reads)
    return dict(version=1, rawErrorRecords=len(errors), primary=dict(total=len(primary), exits=pc['scope_proven_exiting'], liveFdChurn=pc['prior_target_outside_hive'] + pc['masked_unknown_prior_WARN'], priorTargetOutside=pc['prior_target_outside_hive'], maskedUnknownPriorWarn=pc['masked_unknown_prior_WARN'], fail=pc['FAIL'], syntheticIdentityReports=sum(error.get('slot') == 'birthIdentity' for error in primary), classifications=pc, errnoCounts=errnos(primary)), diagnostic=dict(errorRecords=len(diagnostic), classifications=dc, errnoCounts=errnos(diagnostic), atErrorStatReads=len(diagnostic_reads), atErrorStatReadFailures=len(failed_reads), embeddedThreadReadFailures=embedded, observationRetryReads=len(retries), observationRetryReadFailures=failed_retries, exhaustedObservations=sum(observation.get('statRetryExhausted', False) for observation in observation_retries)), additionalDiagnosticFailuresNotSeparateErrorRecords=embedded + failed_retries)


def error_summary_valid(record, errors, diagnostic_reads, observation_retries):
    try:
        return record == error_summary(errors, diagnostic_reads, observation_retries)
    except (KeyError, TypeError, AttributeError):
        return False


def error_summary_totals(records):
    valid = [record for record in records if record is not None]
    fields = ('total', 'exits', 'liveFdChurn', 'priorTargetOutside', 'maskedUnknownPriorWarn', 'fail', 'syntheticIdentityReports')
    diagnostics = ('errorRecords', 'atErrorStatReads', 'atErrorStatReadFailures', 'embeddedThreadReadFailures', 'observationRetryReads', 'observationRetryReadFailures', 'exhaustedObservations')
    return dict(rawErrorRecords=sum(record['rawErrorRecords'] for record in valid), primary={field:sum(record['primary'][field] for record in valid) for field in fields}, diagnostic={field:sum(record['diagnostic'][field] for record in valid) for field in diagnostics}, additionalDiagnosticFailuresNotSeparateErrorRecords=sum(record['additionalDiagnosticFailuresNotSeparateErrorRecords'] for record in valid), missingSummaries=len(records)-len(valid))
