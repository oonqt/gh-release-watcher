import axios from 'axios';
import fs from 'fs';
import ms from 'ms';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { compareVersions, validate } from 'compare-versions';
import Logger from './logger.js';
import pkg from './package.json' with { type: 'json' };

if (process.env.NODE_ENV === 'development') {
    const dotenv = await import('dotenv');
    dotenv.config();
}

const {
    DEBUG,
    NTFY_URL,
    NTFY_AUTH,
    CHECK_INTERVAL,
    REPO_FILE,
    DB_FILE,
    GH_API_KEY
} = process.env;

axios.defaults.headers.common['User-Agent'] = `${pkg.name}/${pkg.version}`;

const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter, { releases: {} });
const log = new Logger(pkg.name, DEBUG === 'true');

const initDb = async () => {
    await db.read();
    db.data = db.data || { releases: [] }
    await db.write();
}

const loadRepoLines = (file) => {
    const lines = 
        fs.readFileSync(file, 'utf8')
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

    return lines;
}

const parseLine = (line) => {
    const parts = line.split(':').map(part => part.trim());
    const repo = parts[0];
    const beta = (parts[1] || '').toLowerCase() === 'beta';

    return { repo, beta }
}

const fetchReleases = async (repo) => {
    const releases = (await axios(`https://api.github.com/repos/${repo}/releases`, {
        headers: {
            "Authorization": `Bearer ${GH_API_KEY}`
        }
    })).data;

    return releases;
}

const sendNtfy = async (title, tag, message) => {
    await axios.post(NTFY_URL, message, {
        headers: {
            "Title": title,
            "Tags": tag,
            "Markdown": "yes",
            "Authorization": NTFY_AUTH ? `Bearer ${NTFY_AUTH}` : ''
        }
    });
}

const processRepoLine = async (line) => {
    const { repo, beta } = parseLine(line);

    log.debug(`Processing ${repo} - beta: ${beta}`);

    const releases = await fetchReleases(repo);

    const latestRelease = 
        releases.find(release => {
            if (release.draft) return false;
            if (!beta && release.beta) return false;

            return true;
        });

    if (!latestRelease) return log.info(`No release found for ${repo} - beta: ${beta}`);
    
    const id = latestRelease.id;
    const tag = latestRelease.tag_name;
    const name = latestRelease.name;
    const publishedAt = latestRelease.published_at;
    const url = latestRelease.html_url;
    const body = latestRelease.body || "No release notes.";
    
    const lastReleaseTag = db.data.releases[id];
    if (!lastReleaseTag) {
        log.debug(`No previous release found for ${id} in database. creating entry and skipping notification`);
        
        db.data.releases[id] = tag;
        await db.write();

        return;
    }

    if (!validate(lastReleaseTag) || !validate(tag)) return log.error(`Unable to parse versions. ${lastReleaseTag} - last release ${tag} - current release`);

    const compareResult = compareVersions(lastReleaseTag, tag);
    // -1 indicates the "v2" release is greater than "v1"
    if (compareResult === -1) {
        log.info(`New release found for ${repo} - id: ${id}`);

        db.data.releases[id] = tag;
        await db.write();
    
        const title = 'New version available!';
        const message = [
            `**${name}**`,
            `Repo: [${repo}](${url})`,
            `Version: ${tag}`,
            `Published: ${new Date(publishedAt).toLocaleString()}`,
            '',
            body
        ].join('\n');
    
        await sendNtfy(title, 'loudspeaker', message);
    } else if (compareResult === 1) {
        log.info(`Version downgrade on remote repository ${id} from ${lastReleaseTag} to ${tag}. Updating local database to reflect`);
        
        db.data.releases[id] = tag;
        await db.write();
    } else {
        return log.debug(`Found no increase in version from ${lastReleaseTag} to ${tag}`);
    }
}

const checkReleases = async () => {
    try {
        log.info('Performing release check');

        const repoLines = loadRepoLines(REPO_FILE);

        log.info(`Found ${repoLines.length} repos to check...`);

        for (const line of repoLines) {
            await processRepoLine(line).catch(err => log.error(`Failed to process line ${line}`, err));
        }
    } catch (err) {
        log.error(err);
    }

    setTimeout(checkReleases, ms(CHECK_INTERVAL));
}

log.info(`Starting ${pkg.name}_v${pkg.version}`);
initDb();
checkReleases();