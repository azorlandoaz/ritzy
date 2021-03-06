import _ from 'lodash'
import invariant from 'react/lib/invariant'
import Spec from 'swarm/lib/Spec'
import Syncable from 'swarm/lib/Syncable'
import { pushSet, setIntersection } from './utils'

class Char {
  constructor(id, char, deletedIds, attributes) {
    this.id = id
    this.char = char
    this.deletedIds = _.isArray(deletedIds) ? new Set(deletedIds) : deletedIds
    this._attributes = attributes ? Object.freeze(attributes) : null
  }

  get attributes() {
    return this._attributes
  }

  set attributes(attrs) {
    this._attributes = attrs ? Object.freeze(attrs) : null
  }

  copyOfAttributes() {
    return this._attributes ? _.clone(this._attributes) : null
  }

  toString() {
    let char = this.char.replace('\n', '↵').replace(' ', '␣')
    return `${char} (${this.id})}`
  }
}

const BASE_CHAR = new Char('00000+swarm', '', null, null)
const EOF = -1

/**
 * Contains the textual data and corresponding lamport timestamps (ids) for each character. Each character
 * has a primary id, but may have secondary ids in a Set representing deleted characters at that position. In
 * addition, each character has a list of other "rich" attributes, such as bold, color, and so forth.
 *
 * Currently the data storage is in regular JS arrays, but perhaps we could use immutable-js:
 *  - (possible) faster or more consistent insertion performance, splice performance is implementation dependent
 *  - blazing fast reference equality comparisons
 */
class TextData {
  constructor() {
    BASE_CHAR.deletedIds = new Set()
    this.chars = [BASE_CHAR]
  }

  len() {
    return this.chars.length
  }

  getChar(pos) {
    invariant(pos < this.len(), 'Index ' + pos + ' out of bounds.')
    // TODO Char should be immutable so that it cannot be modified outside of this class, use Immutable.js Record?
    return this.chars[pos]
  }

  insertChar(pos, char, id, attributes) {
    invariant(pos !== 0, 'Cannot insert at position 0.')
    invariant(pos <= this.len(), 'Index ' + pos + ' out of bounds.')
    this.chars.splice(pos, 0, new Char(id, char, null, this._normalizeAttrs(attributes)))
  }

  deleteChar(pos) {
    invariant(pos !== 0, 'Cannot delete position 0.')
    invariant(pos < this.len(), 'Index ' + pos + ' out of bounds.')
    let previousChar = this.chars[pos - 1]
    let deletedChar = this.chars.splice(pos, 1)[0]
    if(!previousChar.deletedIds) {
      previousChar.deletedIds = new Set()
    }
    previousChar.deletedIds.add(deletedChar.id)
    if(deletedChar.deletedIds) {
      pushSet(deletedChar.deletedIds, previousChar.deletedIds)
    }
  }

  setCharAttr(pos, attributes) {
    invariant(pos !== 0, 'Cannot set attributes of position 0.')
    invariant(pos < this.len(), 'Index ' + pos + ' out of bounds.')

    this.chars[pos].attributes = this._normalizeAttrs(_.clone(attributes))
  }

  matches(pos, ids, includeDeleted) {
    invariant(pos < this.len(), 'Index out of bounds.')
    includeDeleted = includeDeleted !== false
    if(_.isArray(ids) || ids.iterator) {
      if(!ids.iterator) {
        ids = new Set(ids)
      }
      if(ids.has(this.chars[pos].id)) {
        return true
      }
      if(includeDeleted && this.chars[pos].deletedIds) {
        return setIntersection(this.chars[pos].deletedIds, ids).length > 0
      }
    } else {
      if(ids === this.chars[pos].id) {
        return true
      }
      if(includeDeleted && this.chars[pos].deletedIds) {
        return this.chars[pos].deletedIds.has(ids)
      }
    }
    return false
  }

  matchCount(pos, ids, includeDeleted) {
    invariant(pos < this.len(), 'Index out of bounds.')
    includeDeleted = includeDeleted !== false
    let matches = 0
    if(_.isArray(ids) || ids.iterator) {
      if(!ids.iterator) {
        ids = new Set(ids)
      }
      if(ids.has(this.chars[pos].id)) {
        matches += 1
      }
      if(includeDeleted && this.chars[pos].deletedIds) {
        matches += setIntersection(this.chars[pos].deletedIds, ids).length
      }
    } else {
      if(ids === this.chars[pos].id) {
        matches += 1
      }
      if(includeDeleted && this.chars[pos].deletedIds && this.chars[pos].deletedIds.has(ids)) {
        matches += 1
      }
    }
    return matches
  }

  text() {
    return this.chars.map(c => c.char).join('')
  }

  _normalizeAttrs(attrs) {
    if(!attrs) return null
    Object.keys(attrs).filter(a => !attrs[a]).forEach(a => delete attrs[a])
    return _.isEmpty(attrs) ? null : attrs
  }
}

/**
 * This is based on the Text.js demo class from the SwarmJS library by @gritzko, with the following primary
 * differences:
 *
 * 1) The `weave` was replaced with an array of Char objects within TextData.
 *
 * 2) The `weave` contained characters and then backspace characters for deletions. Deletions are now stored in
 * per-character buckets so that they don't have to be constantly filtered out of the weave. This is also quite
 * amenable to tombstone clearing.
 *
 * 3) Added the ability to store rich-text and other attributes in the Char objects.
 *
 * 4) Created an API to get/set changes via "deltas". The delta format is from https://github.com/ottypes/rich-text.
 * This provides some limited support to applications that wish to convert CRDT ops to/from operational transform
 * ops. This support is not currently used by Ritzy and may be removed in the future.
 *
 * 5) A bug in concurrent insertion: the `insert` op was modifying the `ins` object by reference, causing the
 * incorrect information to be transmitted to peers. The insert op needs to remain the same for proper application
 * on other peers.
 *
 * Note that for non-basic multilingual plane (BMP) characters (rare!) using string.length could be wrong in
 * Javascript. See https://mathiasbynens.be/notes/javascript-encoding.
 */
let Text = Syncable.extend('Text', {
  // naive uncompressed CT weave implementation based on Swarm Text.js
  defaults: {
    data: {type: TextData},
    _oplog: Object
  },

  ops: {
    insert(spec, ins, src) {  // eslint-disable-line no-unused-vars
      let vt = spec.token('!'), v = vt.bare
      let ts = v.substr(0, 5), seq = v.substr(5) || '00'
      let seqi = Spec.base2int(seq)
      let genTs
      let insertKeys = ins ? Object.keys(ins) : []
      let matchedInsKeys = []
      for (let i = 0; i < this.data.len() && matchedInsKeys.length < insertKeys.length; i++) {
        for(let j = 0; j < insertKeys.length; j++) {
          let insKey = insertKeys[j]
          if (this.data.matches(i, insKey)) {
            matchedInsKeys.push(insKey)
            let str = ins[insKey].value
            let attrs = ins[insKey].attributes
            let insertionIndex = i + 1
            // check for concurrent edits
            while (insertionIndex < this.data.len() && this.data.getChar(insertionIndex).id > vt.body) {
              insertionIndex++
            }
            for (let k = 0; k < str.length; k++) {
              genTs = ts + (seqi ? Spec.int2base(seqi++, 2) : '') + '+' + vt.ext
              this.data.insertChar(insertionIndex + k, str.charAt(k), genTs, attrs)
              if (!seqi) {
                seqi = 1 // FIXME repeat ids, double insert
              }
            }
            i = str.length + insertionIndex - 1
          }
        }
      }
      if(matchedInsKeys.length < insertKeys.length) {
        console.warn('Insert op does not match any tree content, ignoring. Failed ops=',
          _.difference(insertKeys, matchedInsKeys))
      }
      if (genTs) {
        this._host.clock.checkTimestamp(genTs)
      }
    },

    remove(spec, rm, src) {  // eslint-disable-line no-unused-vars
      //let v = spec.version()
      if(!rm) return
      let rmKeys = Object.keys(rm)
      for (let i = 1; i < this.data.len(); i++) {
        if (this.data.matches(i, rmKeys)) {
          this.data.deleteChar(i)
          i -= 1
        }
      }
    },

    /**
     * Set attributes for the given chars. Attributes are overwritten, therefore it is client code's
     * responsibility to "merge" existing attributes with new ones.
     */
    setAttributes(spec, attrs, src) {  // eslint-disable-line no-unused-vars
      if(!attrs) return
      let attrKeys = Object.keys(attrs)
      for (let i = 1; i < this.data.len(); i++) {
        for(let j = 0; j < attrKeys.length; j++) {
          if (this.data.matches(i, attrKeys[j], false)) {
            this.data.setCharAttr(i, attrs[attrKeys[j]])
          }
        }
      }
    }
  },

  text() {
    return this.data.text()
  },

  /**
   * A delta is based on the operational transform rich text type. See https://github.com/ottypes/rich-text.
   * @param delta
   */
  applyDelta(delta) {
    let rm = null
    let ins = null
    let pos = 1  // skip \n #00000+swarm

    for(let i = 0; i < delta.length; i++) {
      let op = delta[i]
      if(op.insert) {
        invariant(pos > 0, 'Cannot insert at position 0.')
        if(!ins) ins = {}
        ins[this.data.getChar(pos - 1).id] = {
          value: op.insert,
          attributes: op.attributes
        }
        // we don't increment pos here because the insert hasn't actually happened yet
      }
      if(op.delete) {
        invariant(pos > 0, 'Cannot delete position 0.')
        if(!rm) rm = {}
        let rmcount = op.delete
        for (let j = 0; j < rmcount; j++) {
          rm[this.data.getChar(pos).id] = true
          pos += 1
        }
      }
      if(op.retain) {
        pos += op.retain
      }
    }

    if(rm) this.remove(rm)
    if(ins) this.insert(ins)
  },

  /**
   * Obtain a delta based on an insert operation. Note that this must be run *after* the insert has already
   * occurred on the replica. This can be used to obtain deltas for updating a local editor based on an op received
   * from the replica event system.
   * @param op
   * @returns {Array}
   */
  deltaFromInsert(op) {
    let delta = []
    let foundCount = 0
    let opKeys = op ? Object.keys(op) : []
    let lastInsert = 0
    for (let i = 0; i < this.data.len(); i++) {
      for(let j = 0; j < opKeys.length; j++) {
        let opKey = opKeys[j]
        if (this.data.matches(i, opKey)) {
          if (i - lastInsert > 0) delta.push({retain: i - lastInsert})
          let str = op[opKey].value
          let deltaOp = {insert: str}
          let attrs = op[opKey].attributes
          if(attrs) {
            deltaOp.attributes = attrs
          }
          delta.push(deltaOp)
          lastInsert = i + str.length
          foundCount += 1
          if (foundCount >= opKeys.length) {
            return delta
          }
        }
      }
    }
    return delta
  },

  /**
   * Obtain a delta based on a remove operation. Note that this must be run *after* the remove has already
   * occurred on the replica. This can be used to obtain deltas for updating a local editor based on an op received
   * from the replica event system.
   * @param op
   * @returns {Array}
   */
  deltaFromRemove(op) {
    let delta = []
    let foundCount = 0
    let opKeys = Object.keys(op)
    let lastRemove = 0
    for (let i = 0; i < this.data.len(); i++) {
      let matchCount = this.data.matchCount(i, opKeys)
      if (matchCount > 0) {
        if(i - lastRemove > 0) delta.push({ retain: i - lastRemove })
        // since the delete has already occurred we need to use the number of matched ids at the current char
        delta.push({ delete: matchCount })
        lastRemove = i
        foundCount += matchCount
        if(foundCount >= opKeys.length) {
          return delta
        }
      }
    }
    return delta
  },

  /**
   * Insert chars with optional attributes at a given position.
   * @param {Char} char The position at which to insert.
   * @param {string} value The string value to insert.
   * @param {object} [attributes] Attributes to set, or no attributes if not set. The attributes are
   *   cloned before setting so that they cannot be modified by simply changing the object reference.
   *   This type of change would not propagate through the replica.
   */
  insertCharsAt(char, value, attributes) {
    let ins = {}
    ins[char.id] = {
      value: value,
      attributes: attributes
    }
    this.insert(ins)
  },

  /**
   * Delete the given chars.
   * @param {Char|Char[]} chars
   */
  rmChars(chars) {
    if(!chars) return
    let rm = {}
    if(_.isArray(chars)) {
      for(let i = 0; i < chars.length; i++) {
        rm[chars[i].id] = true
      }
    } else {
      rm[chars.id] = true
    }
    this.remove(rm)
  },

  /**
   * Sets new text. All current text contents are deleted (though the deleted ids remain).
   * @param {string} newText
   * @param {object} [attributes]
   */
  set(newText, attributes) {
    this.rmChars(this.getTextRange(BASE_CHAR))
    this.insertCharsAt(BASE_CHAR, newText, attributes)
  },

  /**
   * Gets the length of the current replica data, including the BASE_CHAR (the length of the actual data).
   * @returns {number}
   */
  len() {
    return this.data.len()
  },

  /**
   * Gets the char for the given char or id. Can be used to "refresh" the char information which is
   * a snapshot with the latest replica information.
   * @param {Char|number} charOrId
   * @returns {*}
   */
  getChar(charOrId) {
    return this.getCharRelativeTo(charOrId, 0, 'error')
  },

  /**
   * Gets the char at the given position. Position 0 is always the BASE_CHAR. An Error is thrown
   * if the position is out of bounds.
   * @param {number} pos
   * @returns {*}
   */
  getCharAt(pos) {
    return this.data.getChar(pos)
  },

  /**
   * Returns the index of a given char or ID. Index 0 is always the BASE_CHAR. If the char is not
   * found, returns -1.
   * @param {Char|number} charOrId
   * @param {boolean} [includeDeleted=true] Whether to include deletec chars in the match.
   * @returns number
   */
  indexOf(charOrId, includeDeleted) {
    invariant(charOrId, 'From char must be defined.')
    let id = _.has(charOrId, 'id') ? charOrId.id : charOrId
    for (let i = 0; i < this.data.len(); i++) {
      if (this.data.matches(i, id, includeDeleted)) return i
    }
    return -1
  },

  /**
   * Gets a character relative to another character. Relative can be positive or
   * negative. If the position becomes out of bound, the position can wrap, limit to
   * the end, or error (depending on the last parameter).
   * @param {Char|string} charOrId
   * @param {number} relative
   * @param {string} [wrap='wrap'] The behavior when the index is out of bounds. Must be one
   *   of 'wrap', 'limit', 'eof', or 'error'. 'eof' returns EOF (-1) if past the end.
   * @return {*}
   */
  getCharRelativeTo(charOrId, relative, wrap) {
    invariant(charOrId, 'Char must be defined.')
    if(_.isUndefined(relative)) relative = 0
    if(_.isUndefined(wrap)) wrap = 'wrap'

    if(charOrId === EOF) {
      if(relative > 0 && (wrap === 'limit' || wrap === 'eof')) return EOF
      else if (relative > 0 && wrap === 'error') throw new Error('Index out of bounds, past EOF by: ' + relative)
      else if(relative > 0 && wrap === 'wrap') {
        charOrId = this.data.getChar(this.data.len() - 1)
      }
      else {
        charOrId = this.data.getChar(this.data.len() - 1)
        relative += 1
      }
    }

    let id = _.has(charOrId, 'id') ? charOrId.id : charOrId
    for (let i = 0; i < this.data.len(); i++) {
      if (this.data.matches(i, id)) {
        let index = i + relative
        if(wrap === 'wrap') {
          if(index < 0) index = this.data.len() + index
          else if(index >= this.data.len()) index = index - this.data.len()
        } else if (wrap === 'limit') {
          if(index < 0) index = 0
          else if(index >= this.data.len()) index = this.data.len() - 1
        } else if (wrap === 'eof') {
          if(index < 0) index = 0
          else if(index >= this.data.len()) return EOF
        } else if (wrap === 'error') {
          if(index < 0 || index >= this.data.len()) {
            throw new Error('Index out of bounds: ' + index)
          }
        } else {
          throw new Error('Undefined wrap value: ' + wrap)
        }
        return this.getCharAt(index)
      }
    }
  },

  /**
   * Gets all the chars from a given ID (exclusive) to a given ID (inclusive). The length of the returned
   * range is going to be `pos(toChar) - pos(fromChar)`.
   * @param {Char|string} fromCharOrId
   * @param {Char|string} [toCharOrId = last] If the to char does not exist, then to char is the last char.
   * @returns {Array}
   */
  getTextRange(fromCharOrId, toCharOrId) {
    invariant(fromCharOrId, 'From char must be defined.')
    let fromMatched = false
    let chars = []
    let fromId = _.has(fromCharOrId, 'id') ? fromCharOrId.id : fromCharOrId
    let toId
    if(!_.isUndefined(toCharOrId)) {
      toId = _.has(toCharOrId, 'id') ? toCharOrId.id : toCharOrId
    }

    if(fromId === toId) {
      return chars
    }
    for (let i = 0; i < this.data.len(); i++) {
      if (!fromMatched && this.data.matches(i, fromId)) {
        // the fromId is exclusive
        fromMatched = true
        if(fromId === toId) {
          chars.push(this.getCharAt(i))
          return chars
        }
      } else if(toId && this.data.matches(i, toId)) {
        invariant(fromMatched, 'From id must precede To id.')
        chars.push(this.getCharAt(i))
        return chars
      } else if(fromMatched) {
        chars.push(this.getCharAt(i))
      }
    }
    return chars
  },

  /**
   * Compares the position of two chars. Follows the contract of Java Comparator
   * (http://docs.oracle.com/javase/8/docs/api/java/util/Comparator.html#compare-T-T-) and returns
   * a negative integer, zero, or a positive integer as the first argument is positioned before,
   * equal to, or positioned after the second.
   * @param {Char|string} charOrId1
   * @param {Char|string} charOrId2
   * @return {number}
   */
  compareCharPos(charOrId1, charOrId2) {
    invariant(charOrId1, 'First char must be defined.')
    invariant(charOrId2, 'Second char must be defined.')

    if(charOrId1 === EOF && charOrId2 === EOF) return 0
    else if(charOrId1 === EOF) return 1
    else if(charOrId2 === EOF) return -1

    let char1Id = _.has(charOrId1, 'id') ? charOrId1.id : charOrId1
    let char2Id = _.has(charOrId2, 'id') ? charOrId2.id : charOrId2

    let seen1 = false
    let seen1Index
    let seen2 = false
    let seen2Index
    for (let i = 0; i < this.data.len(); i++) {
      if (!seen1 && this.data.matches(i, char1Id)) {
        seen1 = true
        seen1Index = i
        // special case same char
        if(char1Id === char2Id) {
          return 0
        }
      }
      if (!seen2 && this.data.matches(i, char2Id)) {
        seen2 = true
        seen2Index = i
      }
      if (seen1 && seen2) {
        if(seen1Index < seen2Index) return -1
        else if(seen1Index === seen2Index) return 0
        else return 1
      }
    }
    throw new Error('One or both chars were not found.')
  }
})

export default Text
export { BASE_CHAR, EOF, Char, TextData }
