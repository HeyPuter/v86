/** @suppress {missingProperties} */
// -------------------------------------------------
// --------------------- 9P ------------------------
// -------------------------------------------------
// Ported to newer v86 from https://github.com/humphd/v86/tree/filer-9p-lastknowngood
// Implementation of the 9p filesystem wrapping Filer.js
// based on https://github.com/copy/v86/blob/master/lib/9p.js
// which in turn is based on the 9P2000.L protocol:
// https://code.google.com/p/diod/wiki/protocol

"use strict";

// Feature bit (bit position) for mount tag.
const VIRTIO_9P_F_MOUNT_TAG = 0;
// Assumed max tag length in bytes.
const VIRTIO_9P_MAX_TAGLEN = 254;
const MAX_REPLYBUFFER_SIZE = 16 * 1024 * 1024;
const PUTER_DEFAULT_FILE_MODE = 0o100755;
const PUTER_DEFAULT_FOLDER_MODE = 0o40755;

// const FSCACHE = new Map();
const TEXTEN = new TextEncoder();
/**
 * https://nodejs.org/api/path.html#path_path_resolve_paths
 * @param {...string} paths A sequence of paths or path segments.
 * @return {string}
 */
var SLASH = 47;
var DOT = 46;
var getCWD;
if(typeof process !== "undefined" && typeof process.cwd !== "undefined") {
    getCWD = process.cwd;
}
else {
    getCWD = function () {
        var pathname = window.location.pathname;
        return pathname.slice(0, pathname.lastIndexOf("/") + 1);
    };
}
/**
 * Resolves . and .. elements in a path with directory names
 * @param {string} path
 * @param {boolean} allowAboveRoot
 * @return {string}
 */
function normalizeStringPosix(path, allowAboveRoot) {
    var res = "";
    var lastSlash = -1;
    var dots = 0;
    var code = void 0;
    var isAboveRoot = false;
    for(var i = 0; i <= path.length; ++i) {
        if(i < path.length) {
            code = path.charCodeAt(i);
        }
        else if(code === SLASH) {
            break;
        }
        else {
            code = SLASH;
        }
        if(code === SLASH) {
            if(lastSlash === i - 1 || dots === 1) {
                // NOOP
            }
            else if(lastSlash !== i - 1 && dots === 2) {
                if(res.length < 2 || !isAboveRoot ||
                    res.charCodeAt(res.length - 1) !== DOT ||
                    res.charCodeAt(res.length - 2) !== DOT) {
                    if(res.length > 2) {
                        var start = res.length - 1;
                        var j = start;
                        for(; j >= 0; --j) {
                            if(res.charCodeAt(j) === SLASH) {
                                break;
                            }
                        }
                        if(j !== start) {
                            res = (j === -1) ? "" : res.slice(0, j);
                            lastSlash = i;
                            dots = 0;
                            isAboveRoot = false;
                            continue;
                        }
                    }
                    else if(res.length === 2 || res.length === 1) {
                        res = "";
                        lastSlash = i;
                        dots = 0;
                        isAboveRoot = false;
                        continue;
                    }
                }
                if(allowAboveRoot) {
                    if(res.length > 0) {
                        res += "/..";
                    }
                    else {
                        res = "..";
                    }
                    isAboveRoot = true;
                }
            }
            else {
                var slice = path.slice(lastSlash + 1, i);
                if(res.length > 0) {
                    res += "/" + slice;
                }
                else {
                    res = slice;
                }
                isAboveRoot = false;
            }
            lastSlash = i;
            dots = 0;
        }
        else if(code === DOT && dots !== -1) {
            ++dots;
        }
        else {
            dots = -1;
        }
    }
    return res;
}

/**
 * https://nodejs.org/api/path.html#path_path_resolve_paths
 * @param {...string} args A sequence of paths or path segments.
 * @return {string}
 */
function resolvePath(...args) {

    var paths = [];
    for(var _i = 0; _i < args.length; _i++) {
        paths[_i] = args[_i];
    }
    var resolvedPath = "";
    var resolvedAbsolute = false;
    var cwd = void 0;
    for(var i = paths.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        var path = void 0;
        if(i >= 0) {
            path = paths[i];
        }
        else {
            if(cwd === void 0) {
                cwd = getCWD();
            }
            path = cwd;
        }
        // Skip empty entries
        if(path.length === 0) {
            continue;
        }
        resolvedPath = path + "/" + resolvedPath;
        resolvedAbsolute = path.charCodeAt(0) === SLASH;
    }
    // At this point the path should be resolved to a full absolute path, but
    // handle relative paths to be safe (might happen when process.cwd() fails)
    // Normalize the path (removes leading slash)
    resolvedPath = normalizeStringPosix(resolvedPath, !resolvedAbsolute);
    if(resolvedAbsolute) {
        return "/" + resolvedPath;
    }
    else if(resolvedPath.length > 0) {
        return resolvedPath;
    }
    else {
        return ".";
    }
}

// TODO
// flush

var EPERM = 1;       /* Operation not permitted */
var ENOENT = 2;      /* No such file or directory */
var EEXIST = 17;      /* File exists */
var EINVAL = 22;     /* Invalid argument */
var EOPNOTSUPP = 95;  /* Operation is not supported */
var ENOTEMPTY = 39;  /* Directory not empty */
var EPROTO = 71;  /* Protocol error */

// Mapping from Filer.js to POSIX
const POSIX_ERR_CODE_MAP = {
    "forbidden": 1,
    "permission_denied": 1,
    "EPERM": 1,

    "subject_does_not_exist": 2, // TODO, ADD MORE PUTER ERROR CODES
    "ENOENT": 2,

    "EBADF": 9, // not possible in puter, possible if the user sends incorrect FID ID

    "EBUSY": 11, // Not possible in puter.

    "field_invalid": 2,
    "EINVAL": 22, //

    "dest_is_not_a_directory": 20,
    "ENOTDIR": 20,

    "cannot_overwrite_a_directory": 19,
    "EISDIR": 21,

    "item_with_same_name_exists": 17,
    "EEXIST": 17,

    "ELOOP": 40, // Too many levels of symbolic links, we dont support symlinks (yet!)

    "not_empty": 39,
    "ENOTEMPTY": 39,

    "EIO": 5, // is possible in puter, not reported properly however.
    "EOPNOTSUPP": 95
};

var P9_SETATTR_MODE = 0x00000001;
var P9_SETATTR_UID = 0x00000002;
var P9_SETATTR_GID = 0x00000004;
var P9_SETATTR_SIZE = 0x00000008;
var P9_SETATTR_ATIME = 0x00000010;
var P9_SETATTR_MTIME = 0x00000020;
var P9_SETATTR_CTIME = 0x00000040;
var P9_SETATTR_ATIME_SET = 0x00000080;
var P9_SETATTR_MTIME_SET = 0x00000100;

var P9_STAT_MODE_DIR = 0x80000000;
var P9_STAT_MODE_APPEND = 0x40000000;
var P9_STAT_MODE_EXCL = 0x20000000;
var P9_STAT_MODE_MOUNT = 0x10000000;
var P9_STAT_MODE_AUTH = 0x08000000;
var P9_STAT_MODE_TMP = 0x04000000;
var P9_STAT_MODE_SYMLINK = 0x02000000;
var P9_STAT_MODE_LINK = 0x01000000;
var P9_STAT_MODE_DEVICE = 0x00800000;
var P9_STAT_MODE_NAMED_PIPE = 0x00200000;
var P9_STAT_MODE_SOCKET = 0x00100000;
var P9_STAT_MODE_SETUID = 0x00080000;
var P9_STAT_MODE_SETGID = 0x00040000;
var P9_STAT_MODE_SETVTX = 0x00010000;

const P9_LOCK_TYPE_RDLCK = 0;
const P9_LOCK_TYPE_WRLCK = 1;
const P9_LOCK_TYPE_UNLCK = 2;
const P9_LOCK_TYPES = Object.freeze(["shared", "exclusive", "unlock"]);

const P9_LOCK_FLAGS_BLOCK = 1;
const P9_LOCK_FLAGS_RECLAIM = 2;

const P9_LOCK_SUCCESS = 0;
const P9_LOCK_BLOCKED = 1;
const P9_LOCK_ERROR = 2;
const P9_LOCK_GRACE = 3;

var FID_NONE = -1;
var FID_INODE = 1;
var FID_XATTR = 2;


// https://github.com/darkskyapp/string-hash
function hash32(string) {
    var hash = 5381;
    var i = string.length;

    while(i) {
        hash = (hash * 33) ^ string.charCodeAt(--i);
    }

    /* JavaScript does bitwise operations (like XOR, above) on 32-bit signed
    * integers. Since we want the results to be always positive, convert the
    * signed int to an unsigned by doing an unsigned bitshift. */
    return hash >>> 0;
}

function getQType(type) {
    switch(type) {
        case false:
            return 0x00;
        case true:
            return 0x80;
        default:
            return 0x00;
    }
}

function formatQid(path, stats) {
    if(stats.is_symlink) {
        return {
            type: 0x02,
            version: 0,
            path: hash32(stats.id)
        };
    }
    return {
        type: getQType(stats.is_dir),
        version: 0,
        path: hash32(stats.id)
    };
}

/**
 * @constructor
 *
 * @param {FS} filesystem
 * @param {CPU} cpu
 */
function Virtio9p(filesystem, cpu, bus) {
    // Pass in filesystem = { fs, sh, Path, Buffer }
    this.puterFS = (window.puter && window.puter.fs) || window.parent.puter.fs;
    window.puterFS = this.puterFS;
    // this.sh = filesystem.sh;
    // this.Path = filesystem.Path;
    // this.Buffer = filesystem.Buffer;

    /** @const @type {BusConnector} */
    this.bus = bus;

    //this.configspace = [0x0, 0x4, 0x68, 0x6F, 0x73, 0x74]; // length of string and "host" string
    //this.configspace = [0x0, 0x9, 0x2F, 0x64, 0x65, 0x76, 0x2F, 0x72, 0x6F, 0x6F, 0x74 ]; // length of string and "/dev/root" string
    this.configspace_tagname = [0x70, 0x75, 0x74, 0x65, 0x72, 0x66, 0x73]; // [0x66, 0x69, 0x6C, 0x65, 0x72, 0x39, 0x70]; // "filer9p" string
    this.configspace_taglen = this.configspace_tagname.length; // num bytes
    this.VERSION = "9P2000.L";
    this.BLOCKSIZE = 8192; // Let's define one page.
    this.msize = 8192; // maximum message size
    this.replybuffer = new Uint8Array(this.msize * 2); // Twice the msize to stay on the safe side
    this.replybuffersize = 0;

    this.fids = {};

    /** @type {VirtIO} */
    this.virtio = new VirtIO(cpu,
        {
            name: "virtio-9p",
            pci_id: 0x06 << 3,
            device_id: 0x1049,
            subsystem_device_id: 9,
            common:
            {
                initial_port: 0xA800,
                queues:
                    [
                        {
                            size_supported: 32,
                            notify_offset: 0,
                        },
                    ],
                features:
                    [
                        VIRTIO_9P_F_MOUNT_TAG,
                        VIRTIO_F_VERSION_1,
                        VIRTIO_F_RING_EVENT_IDX,
                        VIRTIO_F_RING_INDIRECT_DESC,
                    ],
                on_driver_ok: () => { },
            },
            notification:
            {
                initial_port: 0xA900,
                single_handler: false,
                handlers:
                    [
                        (queue_id) => {
                            if(queue_id !== 0) {
                                dbg_assert(false, "Virtio-Filer-9P Notified for non-existent queue: " + queue_id +
                                    " (expected queue_id of 0)");
                                return;
                            }
                            while(this.virtqueue.has_request()) {
                                const bufchain = this.virtqueue.pop_request();
                                this.ReceiveRequest(bufchain);
                            }
                            this.virtqueue.notify_me_after(0);
                            // Don't flush replies here: async replies are not completed yet.
                        },
                    ],
            },
            isr_status:
            {
                initial_port: 0xA700,
            },
            device_specific:
            {
                initial_port: 0xA600,
                struct:
                    [
                        {
                            bytes: 2,
                            name: "mount tag length",
                            read: () => this.configspace_taglen,
                            write: data => { /* read only */ },
                        },
                    ].concat(v86util.range(VIRTIO_9P_MAX_TAGLEN).map(index =>
                    ({
                        bytes: 1,
                        name: "mount tag name " + index,
                        // Note: configspace_tagname may have changed after set_state
                        read: () => this.configspace_tagname[index] || 0,
                        write: data => { /* read only */ },
                    })
                    )),
            },
        });
    this.virtqueue = this.virtio.queues[0];
    this.pendingTags = {};
}

Virtio9p.prototype.shouldAbortRequest = function(tag) {
    var shouldAbort = !this.pendingTags[tag];
    if(shouldAbort) {
        message.Debug("Request can be aborted tag=" + tag);
    }
    return shouldAbort;
};

Virtio9p.prototype.get_state = function() {
    var state = [];

    // state[0] = this.configspace_tagname;
    // state[1] = this.configspace_taglen;
    // state[2] = this.virtio;
    // state[3] = this.VERSION;
    // state[4] = this.BLOCKSIZE;
    // state[5] = this.msize;
    // state[6] = this.replybuffer;
    // state[7] = this.replybuffersize;
    // state[8] = this.fids.map(function(f) { return [f.inodeid, f.type, f.uid, f.dbg_name]; });
    // state[9] = this.fs;
    // state[10] = this.sh;
    // state[11] = this.Path;
    // state[12] = this.Buffer;

    state[0] = this.configspace_tagname;
    state[1] = this.configspace_taglen;
    state[2] = this.virtio;
    state[3] = this.VERSION;
    state[4] = this.BLOCKSIZE;
    state[5] = this.msize;
    state[6] = this.replybuffer;
    state[7] = this.replybuffersize;

    if(this.fids.map)
        state[8] = this.fids.map(function(f) { return [f.inodeid, f.type, f.uid, f.dbg_name]; });
    // state[9] = this.fs;

    return state;
};

Virtio9p.prototype.set_state = function(state) {
    this.configspace_tagname = state[0];
    this.configspace_taglen = state[1];
    this.virtio.set_state(state[2]);
    this.virtqueue = this.virtio.queues[0];
    this.VERSION = state[3];
    this.BLOCKSIZE = state[4];
    this.msize = state[5];
    this.replybuffer = state[6];
    this.replybuffersize = state[7];
    this.fids = {};
    this.puterFS = (window.puter && window.puter.fs) || window.parent.puter.fs;
    window.puterFS = this.puterFS;
};


Virtio9p.prototype.Createfid = function(path, type, uid) {
    return { path, type, uid };
};


Virtio9p.prototype.Reset = function() {
    this.fids = {};
};

// Before we begin any async file i/o, mark the tag as being pending
Virtio9p.prototype.addTag = function(tag) {
    this.pendingTags[tag] = {};
};

// Flush an inflight async request
Virtio9p.prototype.flushTag = function(tag) {
    delete this.pendingTags[tag];
};

Virtio9p.prototype.BuildReply = function(id, tag, payloadsize) {
    dbg_assert(payloadsize >= 0, "9P: Negative payload size");
    marshall.Marshall(["w", "b", "h"], [payloadsize + 7, id + 1, tag], this.replybuffer, 0);
    if((payloadsize + 7) >= this.replybuffer.length) {
        message.Debug("Error in 9p: payloadsize exceeds maximum length");
    }
    //for(var i=0; i<payload.length; i++)
    //    this.replybuffer[7+i] = payload[i];
    this.replybuffersize = payloadsize + 7;

};

Virtio9p.prototype.SendError = function(tag, err) {
    //var size = marshall.Marshall(["s", "w"], [errormsg, errorcode], this.replybuffer, 7);
    var errorcode = POSIX_ERR_CODE_MAP[err.code];
    var size = marshall.Marshall(["w"], [errorcode], this.replybuffer, 7);
    this.BuildReply(6, tag, size);
};

Virtio9p.prototype.SendReply = function(bufchain) {
    dbg_assert(this.replybuffersize >= 0, "9P: Negative replybuffersize");
    bufchain.set_next_blob(this.replybuffer.subarray(0, this.replybuffersize));
    this.virtqueue.push_reply(bufchain);
    this.virtqueue.flush_replies();
};

Virtio9p.prototype.ReceiveRequest = async function(bufchain) {
    var self = this;
    // var Path = this.Path;
    // var Buffer = this.buffer;
    // var fs = this.fs;
    var puterFS = this.puterFS;
    // var sh = this.sh;

    // TODO: split into header + data blobs to avoid unnecessary copying.
    const buffer = new Uint8Array(bufchain.length_readable);
    bufchain.get_next_blob(buffer);

    const state = { offset: 0 };
    var header = marshall.Unmarshall(["w", "b", "h"], buffer, state);
    var size = header[0];
    var id = header[1];
    var tag = header[2];

    this.addTag(tag);
    // message.Debug("size:" + size + " id:" + id + " tag:" + tag);
    // console.log(header);
    switch(id) {
        case 8: // statfs
            size = 1024; // this.fs.GetTotalSize(); // size used by all files
            var space = 1024 * 1024 * 1024; // this.fs.GetSpace();
            var req = [];
            req[0] = 0x01021997; // fs type
            req[1] = this.BLOCKSIZE; // optimal transfer block size
            req[2] = Math.floor(space / req[1]); // free blocks
            req[3] = req[2] - Math.floor(size / req[1]); // free blocks in fs
            req[4] = req[2] - Math.floor(size / req[1]); // free blocks avail to non-superuser
            req[5] = 1024 * 1024 * 1024; // total number of inodes
            req[6] = 1024 * 1024; // free inodes
            req[7] = 0; // file system id?
            req[8] = 256; // maximum length of filenames

            size = marshall.Marshall(["w", "w", "d", "d", "d", "d", "d", "d", "w"], req, this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 112: // topen
        case 12: // tlopen
            var req = marshall.Unmarshall(["w", "w"], buffer, state);
            var fid = req[0];
            var mode = req[1];
            var path = this.fids[fid].path;

            message.Debug("[open] fid=" + fid + ", mode=" + mode);
            message.Debug("file open " + this.fids[fid].path);

            puterFS.stat(path).then((stats) => {
                if(self.shouldAbortRequest(tag)) return;

                req[0] = formatQid(path, stats);
                req[1] = self.msize - 24;
                marshall.Marshall(["Q", "w"], req, self.replybuffer, 7);
                self.BuildReply(id, tag, 13 + 4);
                self.SendReply(bufchain);
            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;
                console.error(err);
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });

            break;

        case 70: // link
            // I'm going to incorrectly treat hardlinks as symlinks
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var dfid = req[0];
            var dirPath = self.fids[dfid].path;
            var fid = req[1];
            var existingPath = self.fids[fid].path;
            var name = req[2];
            var newPath = resolvePath(dirPath, name);

            message.Debug("[link] dfid=" + dfid + ", name=" + name);

            // puterFS.symlink(existingPath, newPath).then(() => {
            //     if(self.shouldAbortRequest(tag)) return;

            //     puterFS.stat(newPath).then((stats) => {
            //         if(self.shouldAbortRequest(tag)) return;

            //         var qid = formatQid(newPath, stats);

            //         marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
            //         self.BuildReply(id, tag, 13);
            //         self.SendReply(bufchain);
            //     }).catch((err) => {
            //         if(self.shouldAbortRequest(tag)) return;

            //         if(err) {
            //             self.SendError(tag, err);
            //             self.SendReply(bufchain);
            //         }
            //     });
            // }).catch((err) => {
            //     if(self.shouldAbortRequest(tag)) return;

            //     if(err) {
            //         self.SendError(tag, err);
            //         self.SendReply(bufchain);
            //     }
            // });
            self.SendError(tag, {code: "EIO"});
            self.SendReply(bufchain);
            break;

        case 16: // symlink
            var req = marshall.Unmarshall(["w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var path = self.fids[fid].path;
            var name = req[1];
            var newPath = resolvePath(path, name);
            var symtgt = req[2];
            var newtgt = resolvePath(path, symtgt);
            if(symtgt.startsWith("/")) {
                newtgt = symtgt;
            }
            var gid = req[3];

            // message.Debug("[symlink] fid=" + fid + ", name=" + name + ", symtgt=" + symtgt + ", gid=" + gid);
            // puterFS.symlink(newtgt, newPath).then(function() {
            //     if(self.shouldAbortRequest(tag)) return;

            //     puterFS.stat(newPath).then(function(stats) {
            //         if(self.shouldAbortRequest(tag)) return;

            //         var qid = formatQid(newPath, stats);

            //         marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
            //         self.BuildReply(id, tag, 13);
            //         self.SendReply(bufchain);
            //     }).catch(function(err) {
            //         if(self.shouldAbortRequest(tag)) return;

            //         if(err) {
            //             self.SendError(tag, err);
            //             self.SendReply(bufchain);
            //         }
            //     });
            // }).catch(function(err) {
            //     if(self.shouldAbortRequest(tag)) return;

            //     if(err) {
            //         self.SendError(tag, err);
            //         self.SendReply(bufchain);
            //     }
            // });

            self.SendError(tag, {code: "EIO"});
            self.SendReply(bufchain);
            break;

        case 18: // mknod
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var filePath = self.fids[fid].path;
            var name = req[1];
            var mode = req[2];
            var major = req[3];
            var minor = req[4];
            var gid = req[5];
            message.Debug("[mknod] fid=" + fid + ", name=" + name + ", major=" + major + ", minor=" + minor + "");

            self.SendError(tag, {code: "EOPNOTSUPP"});
            self.SendReply(bufchain);
            break;


        case 22: // TREADLINK
            var req = marshall.Unmarshall(["w"], buffer, state);
            var fid = req[0];
            var path = self.fids[fid].path;

            message.Debug("[readlink] fid=" + fid + " name=" + this.fids[fid].dbg_name + " target=" + "idk");

            puterFS.stat(path).then(stats => {
                if(self.shouldAbortRequest(tag)) return;
                if(!stats.symlink_path) {
                    self.SendError(tag, {code: "EINVAL"});
                    self.sendReply(bufchain);
                }
                size = marshall.Marshall(["s"], [stats.symlink_path], self.replybuffer, 7);
                self.BuildReply(id, tag, size);
                self.SendReply(bufchain);
            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;
                if(err) {
                    self.SendError(tag, err);
                    self.sendReply(bufchain);
                }
            });

            break;


        case 72: // tmkdir
            var req = marshall.Unmarshall(["w", "s", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var mode = req[2];
            var gid = req[3];
            var parentPath = self.fids[fid].path;
            var newDir = resolvePath(parentPath, name);

            message.Debug("[mkdir] fid=" + fid + ", name=" + name + ", mode=" + mode + ", gid=" + gid);

            puterFS.mkdir(newDir).then((stats) => {
                if(self.shouldAbortRequest(tag)) return;

                var qid = formatQid(newDir, stats);
                marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                self.BuildReply(id, tag, 13);
                self.SendReply(bufchain);

            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });

            break;

        case 14: // tlcreate
            var req = marshall.Unmarshall(["w", "s", "w", "w", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var flags = req[2];
            var mode = req[3];
            var gid = req[4];

            var newFilePath = resolvePath(self.fids[fid].path, name);

            // the old code doesn't have this line?
            this.bus.send("9p-create", [name, this.fids[fid].inodeid]);

            message.Debug("[create] fid=" + fid + ", name=" + name + ", flags=" + flags + ", mode=" + mode + ", gid=" + gid);
            puterFS.write(newFilePath, undefined, {overwrite: false}).then((stats) => {
                var qid = formatQid(newFilePath, stats);
                marshall.Marshall(["Q", "w"], [qid, self.msize - 24], self.replybuffer, 7);
                self.fids[fid] = self.Createfid(newFilePath, FID_INODE, uid);
                self.BuildReply(id, tag, 13 + 4);
                self.SendReply(bufchain);
            }).catch((err) => {
                console.error("CREATE FILE ERROR! ", err);
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });
            break;

        case 52: // lock
            // always succeeds
            marshall.Marshall(["b"], [0], this.replybuffer, 7);
            this.BuildReply(id, tag, 1);
            this.SendReply(bufchain);
            break;

        case 54: // getlock
            // apparently does nothing?
            break;

        case 24: // getattr
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            var path = this.fids[fid].path;

            message.Debug("[getattr]: fid=" + fid + " name=" + this.fids[fid].dbg_name + " request mask=" + req[1]);

            // We ignore the request_mask, and always send back all fields except btime, gen, data_version
            function statsToFileAttributes(stats) {
                // P9_GETATTR_BASIC 0x000007ffULL - Mask for all fields except btime, gen, data_version */
                var valid = 0x000007ff;
                var qid = formatQid(path, stats);

                var mode = PUTER_DEFAULT_FILE_MODE; // unix 644 (NEX)
                if(qid.type === 0x80)
                    mode = PUTER_DEFAULT_FOLDER_MODE; // dir 755

                var uid = 0; // root owns
                var gid = 0;
                var nlink = 1;
                var rdev = (0x0 << 8) | (0x0);
                var size = stats.size;
                var blksize = self.BLOCKSIZE;
                var blocks = Math.floor(size / 512 + 1);
                /** @suppress {missingProperties} */
                var atime_sec = stats.accessed;
                /** @suppress {missingProperties} */
                var atime_nsec = stats.accessed * 1000 * 1000000;
                /** @suppress {missingProperties} */
                var mtime_sec = stats.modified;
                /** @suppress {missingProperties} */
                var mtime_nsec = stats.modified * 1000 * 1000000;
                /** @suppress {missingProperties} */
                var ctime_sec = stats.created;
                /** @suppress {missingProperties} */
                var ctime_nsec = stats.created * 1000 * 1000000;
                // Reserved for future use, not supported by us.
                var btime_sec = 0x0;
                var btime_nsec = 0x0;
                var gen = 0x0;
                var data_version = 0x0;

                return [
                    valid, qid, mode, uid, gid, nlink, rdev, size, blksize,
                    blocks, atime_sec, atime_nsec, mtime_sec, mtime_nsec,
                    ctime_sec, ctime_nsec, btime_sec, btime_nsec, gen,
                    data_version
                ];
            }
            puterFS.stat(path).then(stats => {
                if(self.shouldAbortRequest(tag)) return;

                var p9stats = statsToFileAttributes(stats);

                marshall.Marshall([
                    "d", "Q",
                    "w",
                    "w", "w",
                    "d", "d",
                    "d", "d", "d",
                    "d", "d", // atime
                    "d", "d", // mtime
                    "d", "d", // ctime
                    "d", "d", // btime
                    "d", "d",
                ], p9stats, self.replybuffer, 7);
                self.BuildReply(id, tag, 8 + 13 + 4 + 4 + 4 + 8 * 15);
                self.SendReply(bufchain);
            }).catch(err => {
                if(self.shouldAbortRequest(tag)) return;

                self.SendError(tag, err);
                self.SendReply(bufchain);
            });
            break;

        case 26: // setattr
            var req = marshall.Unmarshall(["w", "w",
                "w", // mode
                "w", "w", // uid, gid
                "d", // size
                "d", "d", // atime
                "d", "d", // mtime
            ], buffer, state);
            var fid = req[0];
            var path = this.fids[fid].path;
            const promises = [];
            message.Debug("[setattr]: fid=" + fid + " request mask=" + req[1]);
            if(req[1] & P9_SETATTR_SIZE) {
                promises.push(
                    new Promise(function(resolve, reject) {
                        var size = req[5];

                        message.Debug("[setattr]: size=" + size);
                        puterFS.read(path)
                            .then(blob => blob.arrayBuffer())
                            .then(dat => {
                                puterFS.write(path,new window.parent.Blob([dat.slice(0,size)]), {overwrite: true, dedupeName: false})
                                    .then(() => {
                                        resolve();
                                    })
                                    .catch(err => {
                                        reject(err);
                                    });
                            });
                    })
                );
            } else {
                console.error("UNSUPPORTED 9P SETATTR!: ", req);
                promises.push(
                    new Promise(function(resolve, reject) {
                        resolve();
                        // reject({code: "EOPNOTSUPP"}); // crashes git?
                    }));
            }
            Promise.all(promises)
                .then(function() {
                    self.BuildReply(id, tag, 0);
                    self.SendReply(bufchain);
                })
                .catch(function(err) {
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });
        break;

        case 50: // fsync
            var req = marshall.Unmarshall(["w", "d"], buffer, state);
            var fid = req[0];
            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 40: // TREADDIR
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = this.fids[fid].path;
            // Directory entries are represented as variable-length records:
            // qid[13] offset[8] type[1] name[s]
            puterFS.readdir(path)
                .then((entries) => {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }

                    // first get size
                    var size = entries.reduce(function(currentValue, entry) {
                        return currentValue + 13 + 8 + 1 + 2 + TEXTEN.encode(entry.name).length;
                    }, 0);

                    // Deal with . and ..
                    size += 13 + 8 + 1 + 2 + 1; // "." entry
                    size += 13 + 8 + 1 + 2 + 2; // ".." entry
                    var data = new Uint8Array(size);
                    // Get info for '.'
                    puterFS.stat(path).then(function(stats) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        var dataOffset = 0x0;

                        dataOffset += marshall.Marshall(
                            ["Q", "d", "b", "s"],
                            [
                                formatQid(path, stats),
                                dataOffset + 13 + 8 + 1 + 2 + 1,
                                (stats.is_dir ? PUTER_DEFAULT_FOLDER_MODE: PUTER_DEFAULT_FILE_MODE) >> 12,
                                "."
                            ],
                            data, dataOffset);

                        // Get info for '..'
                        var parentDirPath = resolvePath("..", path);
                        puterFS.stat(path).then(function(stats) {
                            if(self.shouldAbortRequest(tag)) {
                                return;
                            }

                            dataOffset += marshall.Marshall(
                                ["Q", "d", "b", "s"],
                                [
                                    formatQid(parentDirPath, stats),
                                    dataOffset + 13 + 8 + 1 + 2 + 2,
                                    (stats.is_dir ? PUTER_DEFAULT_FOLDER_MODE: PUTER_DEFAULT_FILE_MODE) >> 12,
                                    ".."
                                ],
                                data, dataOffset);

                            entries.forEach(function(entry) {
                                // var entryPath = resolvePath(path, entry.name);
                                dataOffset += marshall.Marshall(
                                    ["Q", "d", "b", "s"],
                                    [
                                        formatQid(entry.path, entry),
                                        dataOffset + 13 + 8 + 1 + 2 + TEXTEN.encode(entry.name).length,
                                        (entry.is_dir ? PUTER_DEFAULT_FOLDER_MODE: PUTER_DEFAULT_FILE_MODE) >> 12,
                                        entry.name
                                    ],
                                    data, dataOffset);
                            });

                            // sometimes seems to break stuff but is in old code?
                            // as a VERY HACKY fix I have used Math.abs but this definitely should NOT be happening
                            if(size < offset + count) {
                                // console.warn("size<offset+count !", "size=" + size, "offset=" + offset, "count=" + count);
                                if(size > offset) {
                                    count = size - offset;
                                } else {
                                    count = 0;
                                }
                            }
                            if(data) {
                                for(var i = 0; i < count; i++)
                                    self.replybuffer[7 + 4 + i] = data[offset + i];
                            }

                            marshall.Marshall(["w"], [count], self.replybuffer, 7);
                            self.BuildReply(id, tag, 4 + count);
                            self.SendReply(bufchain);
                        }).catch(err => {
                            if(self.shouldAbortRequest(tag)) {
                                return;
                            }
                            self.SendError(tag, err);
                            self.SendReply(bufchain);
                        });
                    });

                }).catch(err => {
                    if(self.shouldAbortRequest(tag)) {
                        return;
                    }
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });
            break;
        case 116: // read
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var fidata = this.fids[fid];
            var path = fidata.path;

            message.Debug("[read]: fid=" + fid + " offset=" + offset + " count=" + count);

            function _read(data) {
                var size = data.length;

                if(offset + count > size) {
                    count = size - offset;
                }

                for(var i = 0; i < count; i++)
                    self.replybuffer[7 + 4 + i] = data[offset + i];

                marshall.Marshall(["w"], [count], self.replybuffer, 7);
                self.BuildReply(id, tag, 4 + count);
                self.SendReply(bufchain);
            }

            if(!fidata.rcache) {
                puterFS.read(path)
                    .then(blob => blob.arrayBuffer())
                    .then(function(dat) {
                        const data2 = new Uint8Array(dat);
                        if(self.shouldAbortRequest(tag)) return;

                        fidata.rcache = {data: data2, remaining: data2.byteLength};
                        _read(data2);
                    }).catch(err => {
                        if(self.shouldAbortRequest(tag)) return;
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    });
            } else {
                const file = fidata.rcache;
                _read(file.data);
            }

            break;
        case 118: // write
            var req = marshall.Unmarshall(["w", "d", "w"], buffer, state);
            var fid = req[0];
            var offset = req[1];
            var count = req[2];
            var path = self.fids[fid].path;
            var fidata = this.fids[fid];

            message.Debug("[write]: fid=" + fid + " offset=" + offset + " count=" + count + " fidtype=" + this.fids[fid].type);
            if(!fidata.wops) {
                fidata.wops = [];
            }
            var data = buffer.slice(state.offset);

            fidata.wops.push({
                data: data,
                count: count,
                offset: offset
            });
            marshall.Marshall(["w"], [data.length], self.replybuffer, 7);
            self.BuildReply(id, tag, 4);
            self.SendReply(bufchain);
            break;

        case 74: // RENAMEAT
            var req = marshall.Unmarshall(["w", "s", "w", "s"], buffer, state);
            var olddirfid = req[0];
            var oldname = req[1];
            var oldPath = resolvePath(self.fids[olddirfid].path, oldname);
            var newdirfid = req[2];
            var newname = req[3];
            var newPath = resolvePath(self.fids[newdirfid].path, newname);
            message.Debug("[renameat]: oldname=" + oldname + " newname=" + newname);

            puterFS.move(oldPath, newPath, {overwrite: true, dedupeName: false}).then(function() {
                if(self.shouldAbortRequest(tag)) return;

                self.BuildReply(id, tag, 0);
                self.SendReply(bufchain);
            }).catch(err => {
                console.error("MOVEOP ERR: " + err);
                if(self.shouldAbortRequest(tag)) return;
                self.SendError(tag, err);
                self.SendReply(bufchain);
            });

            break;

        case 76: // TUNLINKAT
            var req = marshall.Unmarshall(["w", "s", "w"], buffer, state);
            var dirfd = req[0];
            var name = req[1];
            var flags = req[2];
            var path = resolvePath(self.fids[dirfd].path, name);

            message.Debug("[unlink]: dirfd=" + dirfd + " name=" + name + " flags=" + flags);

            puterFS.delete(path, {recursive: false})
                .then(() => {
                    if(self.shouldAbortRequest(tag)) return;
                    self.BuildReply(id, tag, 0);
                    self.SendReply(bufchain);
                }).catch((err) => {
                    if(self.shouldAbortRequest(tag)) return;
                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });


            break;

        case 100: // version
            var version = marshall.Unmarshall(["w", "s"], buffer, state);
            message.Debug("[version]: msize=" + version[0] + " version=" + version[1]);
            if(this.msize !== version[0])
            {
                this.msize = version[0];
                this.replybuffer = new Uint8Array(Math.min(MAX_REPLYBUFFER_SIZE, this.msize*2));
            }
            size = marshall.Marshall(["w", "s"], [this.msize, this.VERSION], this.replybuffer, 7);
            this.BuildReply(id, tag, size);
            this.SendReply(bufchain);
            break;

        case 104: // attach
            // return root directorie's QID
            var req = marshall.Unmarshall(["w", "w", "s", "s", "w"], buffer, state);
            var fid = req[0];
            var uid = req[4];
            message.Debug("[attach]: fid=" + fid + " afid=" + hex8(req[1]) + " uname=" + req[2] + " aname=" + req[3]);
            this.fids[fid] = this.Createfid("/", FID_INODE, uid);
            puterFS.stat("/")
                .then(function(stats) {
                    if(self.shouldAbortRequest(tag)) return;

                    var qid = formatQid("/", stats);

                    marshall.Marshall(["Q"], [qid], self.replybuffer, 7);
                    self.BuildReply(id, tag, 13);
                    self.SendReply(bufchain);
                    self.bus.send("9p-attach");
                }).catch(err => {

                    self.SendError(tag, err);
                    self.SendReply(bufchain);
                });
            break;

        case 108: // tflush
            var req = marshall.Unmarshall(["h"], buffer, state);
            var oldtag = req[0];
            this.flushTag(oldtag);
            message.Debug("[flush] " + tag);

            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;


        case 110: // walk
            var req = marshall.Unmarshall(["w", "w", "h"], buffer, state);
            var fid = req[0];
            var nwfid = req[1];
            var nwname = req[2];
            message.Debug("[walk]: fid=" + req[0] + " nwfid=" + req[1] + " nwname=" + nwname);
            if(nwname === 0) {
                this.fids[nwfid] = this.Createfid(this.fids[fid].path, FID_INODE, this.fids[fid].uid);
                //this.fids[nwfid].inodeid = this.fids[fid].inodeid;
                marshall.Marshall(["h"], [0], this.replybuffer, 7);
                this.BuildReply(id, tag, 2);
                this.SendReply(bufchain);
                break;
            }
            var wnames = [];
            for(var i = 0; i < nwname; i++) {
                wnames.push("s");
            }
            var walk = marshall.Unmarshall(wnames, buffer, state);
            var path = this.fids[fid].path;

            var offset = 7 + 2;
            var nwidx = 0;

            message.Debug("walk in dir " + this.fids[fid].dbg_name + " to: " + walk.toString());
            function _walk(path, pathParts) {
                var part = pathParts.shift();

                if(!part) {
                    marshall.Marshall(["h"], [nwidx], self.replybuffer, 7);
                    self.BuildReply(id, tag, offset - 7);
                    self.SendReply(bufchain);
                    return;
                }

                path = resolvePath(path, part);
                puterFS.stat(path)
                    .then(function(stats) {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }

                        var qid = formatQid(path, stats);

                        self.fids[nwfid] = self.Createfid(path, FID_INODE, 0);
                        offset += marshall.Marshall(["Q"], [qid], self.replybuffer, offset);
                        nwidx++;
                        _walk(path, pathParts);
                    }).catch(err => {
                        if(self.shouldAbortRequest(tag)) {
                            return;
                        }
                        self.SendError(tag, err);
                        self.SendReply(bufchain);
                    });
            }

            _walk(path, walk);
            break;

        case 120: // clunk (means close FID)
            var req = marshall.Unmarshall(["w"], buffer, state);
            message.Debug("[clunk]: fid=" + req[0]);
            var fid = req[0];
            var fidata = self.fids[fid];
            if(fidata.wops) {
                puterFS.read(fidata.path)
                    .then(blob => blob.arrayBuffer())
                    .then(arrBuf => {
                        const dat = new Uint8Array(arrBuf);
                        // Calculate length of file to write
                        let length = dat.length;
                        for(const wop of fidata.wops) {
                            const newLen = wop.offset + wop.count;
                            if(newLen > length) {
                                length = newLen;
                            }
                        }

                        const data = new Uint8Array(length); // set old data
                        data.set(dat, 0);
                        for(const wop of fidata.wops) { // set new data ontop of old data
                            data.set(wop.data, wop.offset);
                        }

                        const finalized = new window.parent.Blob([data]); // so instanceof lines up
                        puterFS.write(fidata.path, finalized, {overwrite: true, dedupeName: false, createMissingParents: true})
                            .then(() => {
                                delete self.fids[fid];
                                this.BuildReply(id, tag, 0);
                                this.SendReply(bufchain);
                            }).catch(err => {
                                console.error("FD WRITE&CLOSE ERROR! ", err);
                                this.BuildReply(id, tag, 0);
                                this.SendReply(bufchain);
                                delete self.fids[fid];
                            });


                    }).catch((err) => {
                        console.error(err);
                        delete self.fids[fid];
                        this.BuildReply(id, tag, 0);
                        this.SendReply(bufchain);
                    });

            } else {
                delete self.fids[fid];
                this.BuildReply(id, tag, 0);
                this.SendReply(bufchain);
            }

            break;

        case 32: // txattrcreate
            var req = marshall.Unmarshall(["w", "s", "d", "w"], buffer, state);
            var fid = req[0];
            var name = req[1];
            var attr_size = req[2];
            var flags = req[3];
            message.Debug("[txattrcreate]: fid=" + fid + " name=" + name + " attr_size=" + attr_size + " flags=" + flags);

            // XXX: xattr not supported yet. E.g. checks corresponding to the flags needed.
            this.fids[fid].type = FID_XATTR;

            this.BuildReply(id, tag, 0);
            this.SendReply(bufchain);
            break;

        case 30: // xattrwalk
            var req = marshall.Unmarshall(["w", "w", "s"], buffer, state);
            var fid = req[0];
            var newfid = req[1];
            var name = req[2];
            message.Debug("[xattrwalk]: fid=" + req[0] + " newfid=" + req[1] + " name=" + req[2]);

            // Workaround for Linux restarts writes until full blocksize
            this.SendError(tag, { code: "EOPNOTSUPP" });
            this.SendReply(bufchain);
            break;

        default:
            message.Debug("Error in Virtio9p: Unknown id " + id + " received");
            message.Abort();
            //this.SendError(tag, "Operation i not supported",  EOPNOTSUPP);
            //this.SendReply(bufchain);
            break;
    }

    //consistency checks if there are problems with the filesystem
    //this.fs.Check();
};
