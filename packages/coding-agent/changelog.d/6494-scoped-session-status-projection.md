### Changed

- `gjc sdk session status` and other single-session SDK reads project only the requested session from the session index instead of every indexed session, and readers with no rejected events no longer load the index audit log.
