"""Prepare a normal release-tag commit locally. This command never publishes refs."""
import argparse
import json
from pathlib import Path
import unity_git_package

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--repo', type=Path, required=True)
    parser.add_argument('--author-name', required=True)
    parser.add_argument('--author-email', required=True)
    args = parser.parse_args()
    metadata = json.loads(args.report.read_text())
    commit = unity_git_package.stage_release(args.archive, args.report, args.repo, args.author_name, args.author_email)
    print(json.dumps({'release_commit': commit, 'source_commit': metadata['source_commit'],
        'tag': metadata['tag'], 'published': False,
        'git_url': 'https://github.com/'+metadata['source_repository']+'.git?path=/importers/unity#'+metadata['tag']}, indent=2))
